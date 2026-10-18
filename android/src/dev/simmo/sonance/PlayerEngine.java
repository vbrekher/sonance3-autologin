package dev.simmo.sonance;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
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
 * B2: the engine also holds the audio focus. Each play requests it; when another app takes it, the
 * page is told to pause (and, after a transient loss, to resume), and a duck lowers the volume
 * here without telling the page. The focus listener runs on this thread too.
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
    // A1: usage MEDIA, content MUSIC. B2's focus requests use the same.
    static final AudioAttributes ATTRIBUTES = new AudioAttributes.Builder()
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

    // B2: a duck plays at 20 % until the focus comes back.
    private static final float DUCK_VOLUME = 0.2f;
    private static final String FOCUS_PAUSE = "{type:'focus',action:'pause'}";
    private static final String FOCUS_RESUME = "{type:'focus',action:'resume'}";

    private final AtomicInteger lastId = new AtomicInteger();
    private final HandlerThread thread = new HandlerThread("SonancePlayer");
    private final Handler handler;
    // D224's status checks: network I/O, so never on the player thread.
    private final ExecutorService statusChecks = Executors.newSingleThreadExecutor();
    private final Sink sink;
    private final AudioManager audio;
    private final AudioFocusRequest focusRequest;

    // The player thread only.
    private Session current;
    // B2: the engine holds the focus (a duck included); a transient loss paused the page, so the
    // regain resumes it; a duck lowered the volume.
    private boolean hasFocus;
    private boolean transientLoss;
    private boolean ducked;

    /** One opened stream: AVPlay's open() to close(). */
    private static final class Session {
        final int id;
        final String url;
        final MediaPlayer player = new MediaPlayer();
        boolean preparing;
        boolean prepared;
        boolean playing;
        // start() has been called since the stream was prepared: pause() is valid only then.
        boolean started;
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

    PlayerEngine(Context context, Sink sink) {
        this.sink = sink;
        thread.start();
        handler = new Handler(thread.getLooper());
        audio = context.getSystemService(AudioManager.class);
        // D228: willPauseWhenDucked, so a duck reaches the listener and the engine ducks itself.
        // Without it Android 8+ ducks other apps' players by itself and the listener never hears
        // of it, while a request from Sonance's own uid (the drill) is never ducked by the system:
        // the drill and a real app would then take different paths.
        focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(ATTRIBUTES)
                .setWillPauseWhenDucked(true)
                .setOnAudioFocusChangeListener(this::onFocusChange, handler)
                .build();
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

    /** B2: a play needs the focus (D231); refused, the stream stays unstarted (D229). */
    void play(int id) {
        command(id, "play", true, s -> {
            if (!requestFocus()) return;
            s.player.start();
            s.started = true;
            s.playing = true;
            startTicks();
            // B3's gaps run from one stream's "completed" to the next one's "started".
            Log.i(MainActivity.TAG, "[Sonance] player " + id + ": started");
        });
    }

    void pause(int id) {
        command(id, "pause", true, s -> {
            stopTicks(s);
            // MediaPlayer's pause() in Prepared is an error (-38): a play refused the focus (D229).
            if (s.started) s.player.pause();
            Log.i(MainActivity.TAG, "[Sonance] player " + id + ": paused");
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
            s.started = false;
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

    /** W4 and S4: stops and releases whatever plays, whichever page opened it, and the focus. */
    void release() {
        handler.post(() -> {
            releaseCurrent();
            abandonFocus();
        });
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
                + MainActivity.describe(Uri.parse(url)) + (ducked ? " (ducked, volume " + DUCK_VOLUME + ")" : ""));
    }

    /** The stream, its attributes and the volume (a duck's, B2), on a new or reset player. */
    private void load(Session s) {
        try {
            s.player.setAudioAttributes(ATTRIBUTES);
            float volume = ducked ? DUCK_VOLUME : 1f;
            s.player.setVolume(volume, volume);
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

    // --- B2: audio focus, on the player thread. ---

    /**
     * The focus for a play. D231: only when the engine does not hold it, or holds it after a
     * transient loss (then the play is the user's, and takes it from the other app). Held, and a
     * duck is held, a play keeps it as it is: the next track's start while ducked must not take
     * the focus back from the app that ducked Sonance. D229: refused (a call in progress), the page
     * is told to pause, as for a loss, and the stream stays unstarted.
     */
    private boolean requestFocus() {
        if (hasFocus && !transientLoss) return true;
        int result = audio.requestAudioFocus(focusRequest);
        if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            hasFocus = true;
            transientLoss = false;
            setDucked(false);
            return true;
        }
        Log.w(MainActivity.TAG, "[Sonance] focus: refused (" + result + "): pausing");
        sink.send(FOCUS_PAUSE);
        return false;
    }

    /**
     * Another app took the focus (B2). A loss pauses the page through the shim, as the Stop key
     * does; after a transient one the regain resumes it (the shim resumes only what that pause
     * paused). A duck lowers this engine's volume, and the page is not told.
     */
    private void onFocusChange(int change) {
        switch (change) {
            case AudioManager.AUDIOFOCUS_LOSS:
                hasFocus = false;
                transientLoss = false;
                setDucked(false);
                Log.i(MainActivity.TAG, "[Sonance] focus: lost: pausing");
                sink.send(FOCUS_PAUSE);
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                transientLoss = true;
                Log.i(MainActivity.TAG, "[Sonance] focus: lost for now: pausing");
                sink.send(FOCUS_PAUSE);
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                setDucked(true);
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                setDucked(false);
                Log.i(MainActivity.TAG, "[Sonance] focus: regained" + (transientLoss ? ": resuming" : ""));
                if (transientLoss) {
                    transientLoss = false;
                    sink.send(FOCUS_RESUME);
                }
                break;
            default:
                break;
        }
    }

    /** The volume of the open stream, and of any opened while ducked (load). */
    private void setDucked(boolean duck) {
        if (duck == ducked) return;
        ducked = duck;
        float volume = duck ? DUCK_VOLUME : 1f;
        if (current != null) current.player.setVolume(volume, volume);
        Log.i(MainActivity.TAG, "[Sonance] focus: " + (duck ? "duck" : "unduck") + ", volume " + volume);
    }

    private void abandonFocus() {
        audio.abandonAudioFocusRequest(focusRequest);
        hasFocus = false;
        transientLoss = false;
        setDucked(false);
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
