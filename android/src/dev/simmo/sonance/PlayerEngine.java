package dev.simmo.sonance;

import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The media engine behind the shim's webapis.avplay (ticket-3.xx-androidtv A1-A3): one
 * android.media.MediaPlayer at a time, created, used and released on this engine's own thread.
 * Its listeners therefore run on that thread's Looper too, and no bridge call waits for it.
 *
 * Every open() starts a session with a new id, and close() releases it. A command for any other
 * session is ignored, and every event carries its session's id, so the shim can drop the events of
 * a stream it has already closed. Events go to the Sink as JavaScript object literals for
 * SonanceShim.receive.
 *
 * MediaPlayer stays behind this one class (§2.2), so a later engine swap touches only this file.
 */
final class PlayerEngine {
    /** Receives each event, on the player thread. */
    interface Sink {
        void send(String message);
    }

    // A2: 5 Hz, inside the 4-10 Hz player.js's progress throttle expects.
    private static final int TICK_MS = 200;
    // A1: usage MEDIA, content MUSIC.
    private static final AudioAttributes ATTRIBUTES = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .build();

    // A3: AVPlay's own AVPlayError values (D225). The shim gives a failed prepare's error callback
    // NotSupportedError for NOT_SUPPORTED, the format toast's cause, and UnknownError otherwise.
    static final String ERROR_NOT_SUPPORTED = "PLAYER_ERROR_NOT_SUPPORTED_FILE";
    static final String ERROR_CONNECTION = "PLAYER_ERROR_CONNECTION_FAILED";
    // Samsung's spelling.
    static final String ERROR_GENERIC = "PLAYER_ERROR_GENEREIC";

    // D224: MediaPlayer's HTTP cache retries a failed request ten times, 3 s apart, so an HTTP
    // error status fails a prepare only after about 30 s. A prepare still pending after this long
    // has the stream's status checked, and an error status fails it at once.
    private static final int SLOW_PREPARE_MS = 2000;
    private static final int STATUS_TIMEOUT_MS = 5000;

    private final AtomicInteger lastId = new AtomicInteger();
    private final HandlerThread thread = new HandlerThread("SonancePlayer");
    private final Handler handler;
    // D224's status checks: network I/O, so never on the player thread.
    private final ExecutorService statusChecks = Executors.newSingleThreadExecutor();
    private final Sink sink;

    // The player thread only.
    private Session current;

    /** One opened stream: AVPlay's open() to close(). */
    private static final class Session {
        final int id;
        final String url;
        final MediaPlayer player = new MediaPlayer();
        boolean preparing;
        boolean prepared;
        boolean playing;
        boolean failed;
        // A position has been reported: the stream has played (D224).
        boolean ticked;
        // D224: the slow-prepare status check, while it is due.
        Runnable slowPrepare;
        // setDataSource's failure, reported when the shim prepares (open() itself cannot fail).
        String loadError;
        // Seeks not yet completed. MediaPlayer coalesces overlapping seeks into one completion.
        final List<Integer> seeks = new ArrayList<>();

        Session(int id, String url) {
            this.id = id;
            this.url = url;
        }
    }

    PlayerEngine(Sink sink) {
        this.sink = sink;
        thread.start();
        handler = new Handler(thread.getLooper());
    }

    // --- Commands: called on the bridge's binder thread, run on the player thread. ---

    /** Opens a stream as a new session and returns its id at once. */
    int open(String url) {
        int id = lastId.incrementAndGet();
        handler.post(() -> openNow(id, url));
        return id;
    }

    void prepare(int id) {
        command(id, "prepare", false, s -> {
            if (s.prepared || s.preparing) return;
            if (s.loadError != null) {
                fail(s, s.loadError, "setDataSource");
                return;
            }
            s.player.prepareAsync();
            s.preparing = true;
            s.slowPrepare = () -> checkStatus(s, null);
            handler.postDelayed(s.slowPrepare, SLOW_PREPARE_MS);
        });
    }

    void play(int id) {
        command(id, "play", true, s -> {
            s.player.start();
            s.playing = true;
            startTicks();
        });
    }

    void pause(int id) {
        command(id, "pause", true, s -> {
            stopTicks(s);
            s.player.pause();
        });
    }

    /** A1: seeks to the closest frame, not the previous sync point; "seeked" reports completion. */
    void seek(int id, int ms, int seekId) {
        command(id, "seek", true, s -> {
            s.seeks.add(seekId);
            s.player.seekTo(ms, MediaPlayer.SEEK_CLOSEST);
        });
    }

    void stop(int id) {
        command(id, "stop", false, s -> {
            stopTicks(s);
            s.seeks.clear();
            endPreparing(s);
            if (s.prepared) {
                s.player.stop();
                s.prepared = false;
            } else {
                // Still preparing (or never prepared): back to an unprepared player for the same
                // stream, as AVPlay's IDLE is, so a later prepare works.
                s.player.reset();
                load(s);
            }
        });
    }

    void close(int id) {
        handler.post(() -> {
            if (current != null && current.id == id) releaseCurrent();
        });
    }

    /** W4 and S4: stops and releases whatever plays, whichever page opened it. */
    void release() {
        handler.post(this::releaseCurrent);
    }

    /** The activity is gone: release the player, then end the thread once the queue is done. */
    void quit() {
        release();
        thread.quitSafely();
        statusChecks.shutdownNow();
    }

    // --- The player thread. ---

    private interface Action {
        void run(Session s);
    }

    /**
     * Runs `action` on the player thread if `id` is the open session and no error has ended it
     * (and, with `needsPrepared`, once it is prepared). The shim's state machine only sends calls
     * MediaPlayer accepts, but an error may already be on its way: an IllegalStateException then
     * ends the session as an error, rather than the process.
     */
    private void command(int id, String name, boolean needsPrepared, Action action) {
        handler.post(() -> {
            Session s = live(id);
            if (s == null || (needsPrepared && !s.prepared)) return;
            try {
                action.run(s);
            } catch (IllegalStateException e) {
                fail(s, ERROR_GENERIC, name + ": " + e.getMessage());
            }
        });
    }

    private void openNow(int id, String url) {
        releaseCurrent();
        Session s = new Session(id, url);
        current = s;
        MediaPlayer mp = s.player;
        mp.setOnPreparedListener(p -> {
            if (s != current) return;
            endPreparing(s);
            s.prepared = true;
            // A stream of unknown length (a live transcode) reports -1 or 0.
            int duration = Math.max(0, p.getDuration());
            Log.i(MainActivity.TAG, "[Sonance] player " + id + ": prepared, " + duration + " ms");
            send(s, "prepared", ",duration:" + duration);
        });
        mp.setOnCompletionListener(p -> {
            if (s != current) return;
            stopTicks(s);
            Log.i(MainActivity.TAG, "[Sonance] player " + id + ": completed");
            send(s, "completed", "");
        });
        // A3: returning true means no completion follows an error. D224: an error with no cause
        // MediaPlayer can name, before the stream has played (a missing decoder fails at start),
        // is told apart by the stream's HTTP status.
        mp.setOnErrorListener((p, what, extra) -> {
            if (s != current || s.failed) return true;
            String error = avplayError(what, extra);
            if (error.equals(ERROR_GENERIC) && (s.preparing || (s.prepared && !s.ticked))) {
                endPreparing(s);
                s.failed = true;
                stopTicks(s);
                checkStatus(s, "MediaPlayer " + what + "/" + extra);
            } else {
                fail(s, error, "MediaPlayer " + what + "/" + extra);
            }
            return true;
        });
        mp.setOnInfoListener((p, what, extra) -> {
            if (s != current) return false;
            if (what == MediaPlayer.MEDIA_INFO_BUFFERING_START) send(s, "bufferingstart", "");
            else if (what == MediaPlayer.MEDIA_INFO_BUFFERING_END) send(s, "bufferingcomplete", "");
            else return false;
            return true;
        });
        // The shim calls each completed seek's ok, then reports the position.
        mp.setOnSeekCompleteListener(p -> {
            if (s != current) return;
            int at = position(s);
            for (int seekId : s.seeks) send(s, "seeked", ",seek:" + seekId + ",position:" + at);
            s.seeks.clear();
        });
        load(s);
        Log.i(MainActivity.TAG, "[Sonance] player " + id + ": open "
                + MainActivity.describe(Uri.parse(url)));
    }

    /** The stream and its attributes, on a new or reset player. */
    private static void load(Session s) {
        try {
            s.player.setAudioAttributes(ATTRIBUTES);
            s.player.setDataSource(s.url);
            s.loadError = null;
        } catch (IOException e) {
            s.loadError = ERROR_CONNECTION;
        } catch (IllegalArgumentException | IllegalStateException | SecurityException e) {
            s.loadError = ERROR_GENERIC;
        }
    }

    private void endPreparing(Session s) {
        s.preparing = false;
        if (s.slowPrepare != null) handler.removeCallbacks(s.slowPrepare);
        s.slowPrepare = null;
    }

    /**
     * D224. MediaPlayer reports an HTTP error status (after its retries), a body no extractor can
     * read ("cannot create extractor") and a codec it has no decoder for (at start) alike, as
     * MEDIA_ERROR_SYSTEM. So the stream's own status decides, read off the player thread with the
     * same URL (the user's server only):
     * - after an error with no named cause before the stream has played (`mediaPlayerError`): a
     *   2xx status means the media arrived and could not be played (NOT_SUPPORTED, the format
     *   toast, as AVPlay and the browser report it); an error status or no answer is a
     *   connection error;
     * - while a prepare is slow (`mediaPlayerError` null): an error status ends it at once as a
     *   connection error, instead of after MediaPlayer's 30 s of retries; anything else lets it go
     *   on.
     */
    private void checkStatus(Session s, String mediaPlayerError) {
        statusChecks.execute(() -> {
            int status = httpStatus(s.url);
            handler.post(() -> {
                if (s != current) return;
                String how = "HTTP " + (status > 0 ? status : "no answer");
                if (mediaPlayerError != null) {
                    fail(s, status >= 200 && status < 300 ? ERROR_NOT_SUPPORTED : ERROR_CONNECTION,
                            mediaPlayerError + ", " + how);
                } else if (s.preparing && !s.failed && status >= 400) {
                    endPreparing(s);
                    // Stops MediaPlayer's retries; close() releases it.
                    s.player.reset();
                    fail(s, ERROR_CONNECTION, "prepare still pending, " + how);
                }
            });
        });
    }

    /** The status a GET for the stream's first byte answers, or -1 if none came. */
    private static int httpStatus(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(STATUS_TIMEOUT_MS);
            c.setReadTimeout(STATUS_TIMEOUT_MS);
            c.setRequestProperty("Range", "bytes=0-0");
            return c.getResponseCode();
        } catch (IOException | ClassCastException e) {
            return -1;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void fail(Session s, String error, String detail) {
        s.failed = true;
        stopTicks(s);
        Log.w(MainActivity.TAG, "[Sonance] player " + s.id + ": " + error + " (" + detail + ") on "
                + MainActivity.describe(Uri.parse(s.url)));
        send(s, "error", ",error:'" + error + "'");
    }

    /** The session `id`, if it is the open one and no error has ended it. */
    private Session live(int id) {
        Session s = current;
        return (s != null && s.id == id && !s.failed) ? s : null;
    }

    private void releaseCurrent() {
        if (current == null) return;
        endPreparing(current);
        stopTicks(current);
        current.player.release();
        Log.i(MainActivity.TAG, "[Sonance] player " + current.id + ": released");
        current = null;
    }

    // A2: oncurrentplaytime every 200 ms while playing, from this thread's Handler.
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            Session s = current;
            if (s == null || !s.playing) return;
            s.ticked = true;
            send(s, "tick", ",position:" + position(s));
            handler.postDelayed(this, TICK_MS);
        }
    };

    private void startTicks() {
        handler.removeCallbacks(ticker);
        handler.postDelayed(ticker, TICK_MS);
    }

    private void stopTicks(Session s) {
        s.playing = false;
        handler.removeCallbacks(ticker);
    }

    private static int position(Session s) {
        try {
            return s.player.getCurrentPosition();
        } catch (IllegalStateException e) {
            return 0;
        }
    }

    private void send(Session s, String event, String fields) {
        sink.send("{type:'player',session:" + s.id + ",event:'" + event + "'" + fields + "}");
    }

    /**
     * A3. MediaPlayer reports MEDIA_ERROR_UNKNOWN or _SERVER_DIED as `what`, and the cause, if it
     * knows one, as `extra`; either may carry the cause, so both are read.
     */
    static String avplayError(int what, int extra) {
        if (either(what, extra, MediaPlayer.MEDIA_ERROR_UNSUPPORTED)
                || either(what, extra, MediaPlayer.MEDIA_ERROR_MALFORMED)) {
            return ERROR_NOT_SUPPORTED;
        }
        if (either(what, extra, MediaPlayer.MEDIA_ERROR_IO)
                || either(what, extra, MediaPlayer.MEDIA_ERROR_TIMED_OUT)) {
            return ERROR_CONNECTION;
        }
        return ERROR_GENERIC;
    }

    private static boolean either(int what, int extra, int code) {
        return what == code || extra == code;
    }
}
