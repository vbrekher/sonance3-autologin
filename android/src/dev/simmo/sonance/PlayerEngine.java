package dev.simmo.sonance;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTimestamp;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaCodecList;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The media engine behind the shim's webapis.avplay (ticket-3.xx-androidtv A1-A3).
 *
 * X1 (fix round 1, D240): it decodes with MediaExtractor and MediaCodec and plays through an
 * AudioTrack opened in the PCM encoding the decoder, or a raw extractor track, actually delivers.
 * Android 11's MediaPlayer opened its sink as 16-bit whatever the extractor delivered, so the
 * SHIELD played 24-bit FLAC, which its FLACExtractor hands over as float, as static (PROGRESS
 * 2026-10-19 11:05). To an app's own process, Android's FLAC and WAV extractors deliver 16-bit
 * PCM whatever the file's depth, and say so (D244): float goes to mediaserver only.
 *
 * Threads. The engine's thread ("SonancePlayer") owns the sessions' state, the audio focus, the
 * ticks, and the AudioTrack's play, pause, volume and position. Each prepared stream has a Decoder
 * on a thread of its own, which owns the extractor, the codec, and the AudioTrack's creation,
 * writes and release. The two share only the fields a Decoder guards with its own lock, and the
 * engine thread never waits on a decoder. A decoder's blocking calls (setDataSource and reads,
 * which over HTTP retry for about 30 s) cannot be cancelled, so a cancelled decoder releases what
 * it holds when the stuck call returns. No bridge call waits for either thread.
 *
 * Every open() starts a session with a new id, and close() releases it. A command for any other
 * session is ignored, and every event carries its session's id, so the shim can drop the events of
 * a stream it has already closed. Events go to the Sink as JavaScript object literals for
 * SonanceShim.receive.
 *
 * B2: the engine also holds the audio focus. Each play requests it; when another app takes it, the
 * page is told to pause (and, after a transient loss, to resume), and a duck lowers the volume
 * here without telling the page. The focus listener runs on the engine thread too.
 *
 * X3 (fix round 1): while the keyboard Sonance opened is up, a transient loss is the keyboard's
 * (Gboard takes transient focus as it opens), so it ducks instead of pausing: music keeps playing
 * while the user types, as on Tizen.
 *
 * The engine stays behind this one class (§2.2): X1 changed nothing the page sees.
 */
final class PlayerEngine {
    /** Receives each event, on the engine thread. */
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

    // D224: MediaExtractor's HTTP cache, like MediaPlayer's, retries a failed request ten times,
    // 3 s apart, so an HTTP error status fails a prepare only after about 30 s. A prepare still
    // pending after this long has the stream's status checked, and an error status fails it at once.
    private static final int SLOW_PREPARE_MS = 2000;
    private static final int STATUS_TIMEOUT_MS = 5000;

    // D240: the AudioTrack holds about half a second, capped so that a 192 kHz float stream's
    // buffer fits AudioFlinger's per-process shared heap (1 MiB) with room for the next stream's.
    private static final int TRACK_BUFFER_MS = 500;
    private static final int MAX_TRACK_BYTES = 512 * 1024;
    // A raw extractor track's samples are read into a buffer at least this large.
    private static final int RAW_BUFFER_BYTES = 256 * 1024;
    // A stream starts, and plays on after a seek, once this much audio is queued (or the AudioTrack
    // is full, or the stream has ended).
    private static final int PRIME_MS = 200;
    // T4: "completed" follows the last frame's playing out, or comes this long after it was due.
    private static final int END_SLACK_MS = 500;
    // D242: a direct stream whose data ends this far before its duration was cut off.
    private static final long CUT_OFF_US = 1_000_000;
    // A2, D243: buffering starts when the AudioTrack has less than this much queued while playing,
    // and completes once it and the extractor's cache hold BUFFERED_MS (or the track is 3/4 full,
    // or the stream's end is read or cached).
    private static final int STARVED_MS = 100;
    private static final int BUFFERED_MS = 1000;
    private static final long CODEC_TIMEOUT_US = 10_000;

    // B2: a duck plays at 20 % until the focus comes back.
    private static final float DUCK_VOLUME = 0.2f;
    private static final String FOCUS_PAUSE = "{type:'focus',action:'pause'}";
    private static final String FOCUS_RESUME = "{type:'focus',action:'resume'}";
    // X3, D238: how long after the keyboard closes the focus it took is asked for again.
    private static final int TYPING_REFOCUS_MS = 1000;

    private final AtomicInteger lastId = new AtomicInteger();
    private final HandlerThread thread = new HandlerThread("SonancePlayer");
    private final Handler handler;
    // D224's status checks: network I/O, so never on the engine thread.
    private final ExecutorService statusChecks = Executors.newSingleThreadExecutor();
    private final Sink sink;
    private final AudioManager audio;
    private final AudioFocusRequest focusRequest;
    // Debug builds: each stream's level at the AudioTrack's input, logged at its end (fix round 1
    // T5, the sine probe: the objective "sounds right").
    private final boolean probe;
    // B2: the volume every AudioTrack plays at, a duck's or 1. Set on the engine thread, and read
    // by a decoder as it creates a track.
    private volatile float volume = 1f;

    // The engine thread only.
    private Session current;
    // B2: the engine holds the focus (a duck included); a transient loss paused the page, so the
    // regain resumes it; a duck lowered the volume.
    private boolean hasFocus;
    private boolean transientLoss;
    private boolean ducked;
    // X3: Sonance's keyboard is up; the transient loss in force is the keyboard's (ducked, and its
    // regain resumes nothing); the keyboard still holds the focus (no regain yet).
    private boolean typing;
    private boolean keyboardLoss;
    private boolean keyboardHolds;

    /** One opened stream: AVPlay's open() to close(). The engine thread only. */
    private static final class Session {
        final int id;
        final String url;
        // The stream's decoder since the last prepare; null before it and after stop().
        Decoder decoder;
        boolean preparing;
        boolean prepared;
        // The page plays (play() since the last pause or stop). The AudioTrack starts once the
        // decoder has audio queued and no seek is pending.
        boolean wantPlay;
        // The AudioTrack runs, and ticks are sent.
        boolean playing;
        // "started" has been logged for this play().
        boolean startLogged;
        boolean failed;
        boolean completed;
        boolean buffering;
        // A position has been reported: the stream has played (D224).
        boolean ticked;
        // D224: the slow-prepare status check, while it is due.
        Runnable slowPrepare;
        // Seeks not yet answered, and the latest one's generation and target. The latest wins, and
        // its completion answers every pending id.
        final List<Integer> seeks = new ArrayList<>();
        int seekGen;
        int seekMs;
        // T4: "completed" is due by this uptime at the latest (0: not yet known), and its check.
        long endDeadline;
        Runnable endCheck;

        Session(int id, String url) {
            this.id = id;
            this.url = url;
        }
    }

    PlayerEngine(Context context, boolean probe, Sink sink) {
        this.sink = sink;
        this.probe = probe;
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

    // --- Commands: called on the bridge's binder thread, run on the engine thread. ---

    /** Opens a stream as a new session and returns its id at once. */
    int open(String url) {
        int id = lastId.incrementAndGet();
        handler.post(() -> openNow(id, url));
        return id;
    }

    void prepare(int id) {
        command(id, "prepare", false, s -> {
            if (s.prepared || s.preparing) return;
            s.preparing = true;
            s.decoder = new Decoder(s);
            s.decoder.thread.start();
            s.slowPrepare = () -> checkStatus(s, null);
            handler.postDelayed(s.slowPrepare, SLOW_PREPARE_MS);
        });
    }

    /** B2: a play needs the focus (D231); refused, the stream stays unstarted (D229). */
    void play(int id) {
        command(id, "play", true, s -> {
            if (!requestFocus()) return;
            s.wantPlay = true;
            s.startLogged = false;
            startIfReady(s);
        });
    }

    void pause(int id) {
        command(id, "pause", true, s -> {
            s.wantPlay = false;
            halt(s);
            Log.i(MainActivity.TAG, "[Sonance] player " + id + ": paused");
        });
    }

    /**
     * A1: seeks to the closest frame (the decoder cuts what comes before it); "seeked" reports its
     * completion, once audio from the target is queued.
     */
    void seek(int id, int ms, int seekId) {
        command(id, "seek", true, s -> {
            s.seeks.add(seekId);
            s.seekGen++;
            s.seekMs = Math.max(0, ms);
            s.completed = false;
            // The AudioTrack is paused before the decoder flushes it: a flush does nothing while
            // it plays.
            halt(s);
            s.decoder.seek(s.seekMs * 1000L, s.seekGen);
        });
    }

    /** AVPlay's IDLE: the same stream, unprepared, so a later prepare starts it afresh. */
    void stop(int id) {
        command(id, "stop", false, s -> {
            s.wantPlay = false;
            halt(s);
            s.seeks.clear();
            endPreparing(s);
            if (s.decoder != null) s.decoder.cancel();
            s.decoder = null;
            // The next prepare's decoder counts its seeks from 0.
            s.seekGen = 0;
            s.prepared = false;
            s.completed = false;
            s.buffering = false;
        });
    }

    void close(int id) {
        handler.post(() -> {
            if (current != null && current.id == id) releaseCurrent();
        });
    }

    /** X3: the host opened (true) or closed (false) the system keyboard. */
    void setTyping(boolean on) {
        handler.post(() -> {
            if (typing == on) return;
            typing = on;
            handler.removeCallbacks(refocusAfterTyping);
            if (!on && keyboardHolds) handler.postDelayed(refocusAfterTyping, TYPING_REFOCUS_MS);
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

    // --- The engine thread. ---

    private interface Action {
        void run(Session s);
    }

    /**
     * Runs `action` on the engine thread if `id` is the open session and no error has ended it
     * (and, with `needsPrepared`, once it is prepared). The shim's state machine only sends calls
     * the engine accepts, but an AudioTrack may refuse one (IllegalStateException): that ends the
     * session as an error, rather than the process.
     */
    private void command(int id, String name, boolean needsPrepared, Action action) {
        handler.post(() -> {
            Session s = live(id);
            if (s == null || (needsPrepared && !s.prepared)) return;
            run(s, name, action);
        });
    }

    /** A decoder's report, on the engine thread, if that decoder is still its session's. */
    private void post(Decoder d, String name, Action action) {
        handler.post(() -> {
            Session s = current;
            if (s == null || s.decoder != d || s.failed) return;
            run(s, name, action);
        });
    }

    private void run(Session s, String name, Action action) {
        try {
            action.run(s);
        } catch (IllegalStateException e) {
            fail(s, ERROR_GENERIC, name + ": " + e.getMessage());
        }
    }

    private void openNow(int id, String url) {
        releaseCurrent();
        current = new Session(id, url);
        Log.i(MainActivity.TAG, "[Sonance] player " + id + ": open "
                + MainActivity.describe(Uri.parse(url)) + (ducked ? " (ducked, volume " + DUCK_VOLUME + ")" : ""));
    }

    private void onPrepared(Session s, int duration) {
        if (!s.preparing) return;
        endPreparing(s);
        s.prepared = true;
        Log.i(MainActivity.TAG, "[Sonance] player " + s.id + ": prepared, " + duration + " ms");
        send(s, "prepared", ",duration:" + duration);
    }

    /** The decoder has audio queued since its seek `gen`: that seek is done, and play may start. */
    private void onPrimed(Session s, int gen) {
        if (gen != s.seekGen) return;
        // The shim calls each completed seek's ok, then reports the position.
        for (int seekId : s.seeks) send(s, "seeked", ",seek:" + seekId + ",position:" + s.seekMs);
        s.seeks.clear();
        startIfReady(s);
    }

    /** The decoder has written the stream's last frame and the pad after it. */
    private void onEnded(Session s) {
        if (s.buffering) {
            s.buffering = false;
            send(s, "bufferingcomplete", "");
        }
        checkEnd(s);
    }

    /**
     * The decoder stopped. `error` names the cause; null means none could be named, and D224
     * applies: before the stream has played, its HTTP status tells a body no extractor can read
     * (NOT_SUPPORTED, the format toast) from a failed request (a connection error).
     */
    private void onDecoderError(Session s, String error, String detail) {
        if (error != null || s.ticked) {
            fail(s, error != null ? error : ERROR_GENERIC, detail);
            return;
        }
        endPreparing(s);
        s.failed = true;
        halt(s);
        checkStatus(s, detail);
    }

    /** Starts the AudioTrack if the page plays, the decoder has audio queued and no seek is pending. */
    private void startIfReady(Session s) {
        Decoder d = s.decoder;
        if (d == null || !s.wantPlay || !s.seeks.isEmpty() || s.failed || s.completed) return;
        if (!d.startTrack(s.seekGen)) return;
        if (!s.startLogged) {
            s.startLogged = true;
            // B3's gaps run from one stream's "completed" to the next one's "started".
            Log.i(MainActivity.TAG, "[Sonance] player " + s.id + ": started");
        }
        if (!s.playing) startTicks(s);
        checkEnd(s);
    }

    /** The AudioTrack and the ticks stop; the stream stays where it is. */
    private void halt(Session s) {
        stopTicks(s);
        s.endDeadline = 0;
        if (s.endCheck != null) handler.removeCallbacks(s.endCheck);
        if (s.decoder != null) s.decoder.pauseTrack();
    }

    /**
     * T4: "completed" once the stream's last frame has played out (the AudioTrack's timestamp, or
     * its head position, reaching the frames written before the pad), or END_SLACK_MS after it was
     * due if neither shows it. Only while playing: a pause holds it, and the next play sets it again.
     */
    private void checkEnd(Session s) {
        if (s.endCheck != null) handler.removeCallbacks(s.endCheck);
        Decoder d = s.decoder;
        if (d == null || !s.playing || s.completed || s.failed) return;
        long left = d.framesLeft();
        if (left < 0) return;
        long leftMs = d.ms(left);
        long now = SystemClock.uptimeMillis();
        if (s.endDeadline == 0) s.endDeadline = now + leftMs + END_SLACK_MS;
        if (left == 0 || now >= s.endDeadline) {
            s.completed = true;
            halt(s);
            Log.i(MainActivity.TAG, "[Sonance] player " + s.id + ": completed");
            send(s, "completed", "");
            return;
        }
        if (s.endCheck == null) s.endCheck = () -> checkEnd(s);
        handler.postDelayed(s.endCheck, Math.max(10, Math.min(leftMs, 100)));
    }

    /** A2: buffering, by the audio queued while playing (D243). */
    private void checkBuffering(Session s) {
        Decoder d = s.decoder;
        if (d == null) return;
        if (!s.buffering && d.starved()) {
            s.buffering = true;
            send(s, "bufferingstart", "");
        } else if (s.buffering && d.buffered()) {
            s.buffering = false;
            send(s, "bufferingcomplete", "");
        }
    }

    private void endPreparing(Session s) {
        s.preparing = false;
        if (s.slowPrepare != null) handler.removeCallbacks(s.slowPrepare);
        s.slowPrepare = null;
    }

    /**
     * D224. MediaExtractor's setDataSource fails alike for an HTTP error status (after its
     * retries) and for a body no extractor can read, so the stream's own status decides, read off
     * the engine thread with the same URL (the user's server only):
     * - after an error with no named cause before the stream has played (`decoderError`): a 2xx
     *   status means the media arrived and could not be played (NOT_SUPPORTED, the format toast,
     *   as AVPlay and the browser report it); an error status or no answer is a connection error;
     * - while a prepare is slow (`decoderError` null): an error status ends it at once as a
     *   connection error, instead of after the extractor's 30 s of retries; anything else lets it
     *   go on.
     */
    private void checkStatus(Session s, String decoderError) {
        statusChecks.execute(() -> {
            int status = httpStatus(s.url);
            handler.post(() -> {
                if (s != current) return;
                String how = "HTTP " + (status > 0 ? status : "no answer");
                if (decoderError != null) {
                    fail(s, status >= 200 && status < 300 ? ERROR_NOT_SUPPORTED : ERROR_CONNECTION,
                            decoderError + ", " + how);
                } else if (s.preparing && !s.failed && status >= 400) {
                    // The decoder is cancelled; its setDataSource returns when its retries end.
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
        endPreparing(s);
        halt(s);
        if (s.decoder != null) s.decoder.cancel();
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
        halt(current);
        if (current.decoder != null) current.decoder.cancel();
        Log.i(MainActivity.TAG, "[Sonance] player " + current.id + ": released");
        current = null;
    }

    // --- B2: audio focus, on the engine thread. ---

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
            keyboardLoss = false;
            keyboardHolds = false;
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
                keyboardLoss = false;
                keyboardHolds = false;
                setDucked(false);
                Log.i(MainActivity.TAG, "[Sonance] focus: lost: pausing");
                sink.send(FOCUS_PAUSE);
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                transientLoss = true;
                keyboardLoss = typing;
                keyboardHolds = typing;
                if (typing) {
                    // X3: the page is not told. The log text differs from the pause's, which the
                    // device checks count.
                    Log.i(MainActivity.TAG, "[Sonance] focus: lost for now while typing: ducking");
                    setDucked(true);
                    break;
                }
                Log.i(MainActivity.TAG, "[Sonance] focus: lost for now: pausing");
                sink.send(FOCUS_PAUSE);
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                setDucked(true);
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                setDucked(false);
                handler.removeCallbacks(refocusAfterTyping);
                if (keyboardLoss) {
                    // X3: the page never paused, so nothing resumes. transientLoss stays set, so the
                    // next play still asks for the focus (D231).
                    Log.i(MainActivity.TAG, "[Sonance] focus: regained" + (keyboardHolds ? " after typing" : ""));
                    keyboardHolds = false;
                    break;
                }
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

    /**
     * X3, D238: the keyboard has closed, and 1 s later it still holds the focus it took. Without
     * this, Sonance would play on ducked until the next play asked for the focus (D231 asks only
     * on a play). Only a focus the engine held before the keyboard took it is asked for again.
     */
    private final Runnable refocusAfterTyping = new Runnable() {
        @Override
        public void run() {
            if (typing || !keyboardHolds || !hasFocus) return;
            int result = audio.requestAudioFocus(focusRequest);
            if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                transientLoss = false;
                keyboardLoss = false;
                keyboardHolds = false;
                Log.i(MainActivity.TAG, "[Sonance] focus: taken back after typing");
                setDucked(false);
            } else {
                Log.w(MainActivity.TAG, "[Sonance] focus: not taken back after typing (" + result + ")");
            }
        }
    };

    /** The volume of the open stream's AudioTrack, and of any created while ducked (createTrack). */
    private void setDucked(boolean duck) {
        if (duck == ducked) return;
        ducked = duck;
        volume = duck ? DUCK_VOLUME : 1f;
        if (current != null && current.decoder != null) current.decoder.applyVolume();
        Log.i(MainActivity.TAG, "[Sonance] focus: " + (duck ? "duck" : "unduck") + ", volume " + volume);
    }

    private void abandonFocus() {
        audio.abandonAudioFocusRequest(focusRequest);
        handler.removeCallbacks(refocusAfterTyping);
        hasFocus = false;
        transientLoss = false;
        keyboardLoss = false;
        keyboardHolds = false;
        setDucked(false);
    }

    // A2: oncurrentplaytime every 200 ms while playing, from this thread's Handler.
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            Session s = current;
            if (s == null || !s.playing) return;
            s.ticked = true;
            send(s, "tick", ",position:" + s.decoder.positionMs());
            checkBuffering(s);
            handler.postDelayed(this, TICK_MS);
        }
    };

    private void startTicks(Session s) {
        s.playing = true;
        handler.removeCallbacks(ticker);
        handler.postDelayed(ticker, TICK_MS);
    }

    private void stopTicks(Session s) {
        s.playing = false;
        handler.removeCallbacks(ticker);
    }

    private void send(Session s, String event, String fields) {
        // No event from a session the page has closed (fix round 1, T6).
        if (s != current) return;
        sink.send("{type:'player',session:" + s.id + ",event:'" + event + "'" + fields + "}");
    }

    /** A stream the engine cannot play: NOT_SUPPORTED, the format toast. */
    private static final class Unsupported extends Exception {
        private static final long serialVersionUID = 1L;

        Unsupported(String message) {
            super(message);
        }
    }

    /**
     * X1: one stream, from prepare() to its session's stop or end, on its own thread: the
     * extractor, the codec (none for a raw extractor track: the FLAC and WAV extractors decode
     * themselves), and the AudioTrack, created on the first output format in the encoding that
     * format reports (16-bit unless it says otherwise) and recreated if it changes (HE-AAC's sample
     * rate). Integer PCM wider than 16 bits is converted to float on every API level (AudioTrack
     * takes it only from API 31), so the emulator runs the same code as Android 8 to 11.
     *
     * The fields marked "shared" are read by the engine thread and guarded by this object; the
     * engine thread calls only the synchronized methods. Everything else is the decoder's thread's.
     */
    private final class Decoder implements Runnable {
        final Session s;
        final Thread thread;

        // Shared.
        private AudioTrack track;
        private boolean trackStarted;
        private int rate = 1;
        private int frameBytes = 1;
        private int capacityFrames;
        private int capacityMs;
        // Frames written to the AudioTrack since it was created or flushed, and the media time of
        // the first of them (-1 until one is written to a new track).
        private long written;
        private long startUs = -1;
        // At the end of the stream: the frames of the stream's own audio written (the pad follows
        // them); -1 before.
        private long endFrames = -1;
        // Audio is queued since the seek `primedGen` (0: the first prepare).
        private boolean primed;
        private int primedGen;
        // The latest seek asked for (-1: none) and its generation.
        private long seekUs = -1;
        private int seekGen;
        private boolean cancelled;
        // The extractor's cache ahead of its read position (-1: unknown), and whether it holds the
        // rest of the stream.
        private long cachedUs = -1;
        private boolean cacheEnd;
        private int lastMs;
        private final AudioTimestamp timestamp = new AudioTimestamp();

        // The decoder's thread only.
        private MediaExtractor extractor;
        private MediaCodec codec;
        private long durationUs;
        private MediaFormat rawFormat;
        private ByteBuffer raw;
        // The decoded encoding, and the AudioTrack's (float for wider integer PCM).
        private int encoding;
        private int trackEncoding;
        private int channels;
        private ByteBuffer converted;
        // The seek generation decoded now; frames before cutUs are dropped (a seek's target).
        private int gen;
        private long cutUs = -1;
        private long lastSampleUs = -1;
        private boolean inputDone;
        private boolean outputDone;
        private boolean ended;
        // The chunk being written: its data, the codec buffer it is in (-1: none), its media time.
        private ByteBuffer pending;
        private int pendingIndex = -1;
        private long pendingUs;
        private boolean padding;
        // The sine probe (debug builds).
        private double peak;
        private double sumSquares;
        private long samples;

        Decoder(Session s) {
            this.s = s;
            thread = new Thread(this, "SonanceDecode-" + s.id);
            thread.setDaemon(true);
        }

        // --- The engine thread's side. ---

        /** The session is over: the AudioTrack falls silent now, and the thread ends and releases. */
        synchronized void cancel() {
            cancelled = true;
            pauseTrack();
            notifyAll();
        }

        synchronized void pauseTrack() {
            if (track != null && trackStarted) {
                track.pause();
                trackStarted = false;
            }
        }

        synchronized void seek(long us, int g) {
            seekUs = us;
            seekGen = g;
            primed = false;
            notifyAll();
        }

        /** Plays the AudioTrack if audio is queued since the seek `g`; true if it plays (or none is needed). */
        synchronized boolean startTrack(int g) {
            if (!primed || primedGen != g) return false;
            if (track != null && !trackStarted) {
                track.play();
                trackStarted = true;
                notifyAll();
            }
            return true;
        }

        synchronized void applyVolume() {
            if (track != null) track.setVolume(volume);
        }

        synchronized int positionMs() {
            if (track != null && startUs >= 0) lastMs = (int) ((startUs + head() * 1_000_000L / rate) / 1000);
            return lastMs;
        }

        /** The frames of the stream's own audio still to play out, or -1 before its end. */
        synchronized long framesLeft() {
            if (endFrames < 0) return -1;
            if (track == null) return 0;
            return Math.max(0, endFrames - presented());
        }

        synchronized long ms(long frames) {
            return frames * 1000 / rate;
        }

        /**
         * D243: the AudioTrack has under STARVED_MS queued, short of the stream's end. Its own queue
         * decides: the extractor's cached duration, published before each read, still counts audio
         * that a blocked read is waiting to complete.
         */
        synchronized boolean starved() {
            return track != null && endFrames < 0 && !cacheEnd && queuedFrames() * 1000 / rate < STARVED_MS;
        }

        /**
         * D243: buffering is over once the AudioTrack and the extractor's cache hold BUFFERED_MS, or
         * the track is 3/4 full (it holds about 500 ms, and less at high rates), or the stream's end
         * is read or cached.
         */
        synchronized boolean buffered() {
            if (track == null || endFrames >= 0 || cacheEnd) return true;
            long ms = queuedFrames() * 1000 / rate;
            return ms >= capacityMs * 3 / 4 || ms + Math.max(0, cachedUs) / 1000 >= BUFFERED_MS;
        }

        private long queuedFrames() {
            return Math.max(0, written - head());
        }

        // The head position counts the frames handed to the mixer. It is unsigned, and a flush
        // resets it.
        private long head() {
            return track.getPlaybackHeadPosition() & 0xFFFFFFFFL;
        }

        // The frames played out: the AudioTrack's timestamp where it has one (moved on to now while
        // the track plays), else the head position.
        private long presented() {
            long head = head();
            if (!track.getTimestamp(timestamp)) return head;
            long frames = timestamp.framePosition;
            if (trackStarted) frames += (System.nanoTime() - timestamp.nanoTime) * rate / 1_000_000_000L;
            return Math.min(frames, head);
        }

        // --- The decoder's thread. ---

        @Override
        public void run() {
            Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
            try {
                if (open()) decode();
            } catch (Unsupported e) {
                report(ERROR_NOT_SUPPORTED, e.getMessage());
            } catch (IOException e) {
                report(null, "MediaExtractor: " + e.getMessage());
            } catch (RuntimeException e) {
                report(null, e.getClass().getSimpleName() + ": " + e.getMessage());
            } finally {
                releaseAll();
            }
        }

        private synchronized boolean isCancelled() {
            return cancelled;
        }

        private void report(String error, String detail) {
            if (!isCancelled()) post(this, "decoder", s -> onDecoderError(s, error, detail));
        }

        /** The stream, its first audio track and that track's decoder; then "prepared". */
        private boolean open() throws IOException, Unsupported {
            extractor = new MediaExtractor();
            extractor.setDataSource(s.url);
            if (isCancelled()) return false;
            MediaFormat format = null;
            for (int i = 0; i < extractor.getTrackCount() && format == null; i++) {
                MediaFormat f = extractor.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    extractor.selectTrack(i);
                    format = f;
                }
            }
            if (format == null) throw new Unsupported("no audio track");
            String mime = format.getString(MediaFormat.KEY_MIME);
            // A stream of unknown length (a live transcode) has none: 0.
            durationUs = format.containsKey(MediaFormat.KEY_DURATION) ? Math.max(0, format.getLong(MediaFormat.KEY_DURATION)) : 0;
            if (MediaFormat.MIMETYPE_AUDIO_RAW.equals(mime)) {
                rawFormat = format;
                int size = format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE) ? format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) : 0;
                raw = ByteBuffer.allocateDirect(Math.max(size, RAW_BUFFER_BYTES)).order(ByteOrder.nativeOrder());
            } else {
                // ALAC: AOSP has no decoder, which this finds before any audio is read (D224).
                String name = new MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(format);
                if (name == null) throw new Unsupported("no decoder for " + mime);
                codec = MediaCodec.createByCodecName(name);
                codec.configure(format, null, null, 0);
                codec.start();
            }
            int duration = (int) (durationUs / 1000);
            post(this, "prepared", s -> onPrepared(s, duration));
            return true;
        }

        private void decode() throws Unsupported {
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            while (true) {
                if (takeSeek()) continue;
                if (isCancelled()) return;
                if (pending != null) {
                    if (!writePending()) await(true);
                } else if (!outputDone) {
                    next(info);
                } else if (!ended) {
                    if (!end()) return;
                } else {
                    await(false);
                }
            }
        }

        /** A seek asked for since the last look: done now (true), the latest one only. */
        private boolean takeSeek() {
            long us;
            synchronized (this) {
                if (seekUs < 0) return false;
                us = seekUs;
                seekUs = -1;
                gen = seekGen;
            }
            dropPending();
            synchronized (this) {
                if (track != null) {
                    // The engine paused it already; a flush does nothing while it plays.
                    track.pause();
                    track.flush();
                    trackStarted = false;
                }
                written = 0;
                // The position runs from the first frame written after the seek: the target, once
                // cut, unless the extractor lands elsewhere (an Ogg stream's estimated length, D226).
                startUs = -1;
                endFrames = -1;
            }
            extractor.seekTo(us, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
            if (codec != null) codec.flush();
            cutUs = us;
            lastSampleUs = us;
            inputDone = false;
            outputDone = false;
            ended = false;
            return true;
        }

        /** Waits for a command, or, while the AudioTrack plays and is full, for room in it. */
        private void await(boolean full) {
            synchronized (this) {
                if (cancelled || seekUs >= 0) return;
                long ms = full && trackStarted ? Math.max(5, Math.min(50, capacityMs / 4)) : 0;
                try {
                    wait(ms);
                } catch (InterruptedException e) {
                    cancelled = true;
                }
            }
        }

        /** Reads or decodes the next chunk into `pending`, or reaches the end of the stream. */
        private void next(MediaCodec.BufferInfo info) throws Unsupported {
            if (codec == null) {
                publishCache();
                raw.clear();
                int n = extractor.readSampleData(raw, 0);
                if (n < 0) {
                    outputDone = true;
                    return;
                }
                long us = extractor.getSampleTime();
                lastSampleUs = us;
                extractor.advance();
                raw.position(0);
                raw.limit(n);
                if (track == null) {
                    createTrack(rawFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE),
                            rawFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT), pcmEncoding(rawFormat));
                }
                take(raw, -1, us);
                return;
            }
            if (!inputDone) {
                int in = codec.dequeueInputBuffer(CODEC_TIMEOUT_US);
                if (in >= 0) {
                    publishCache();
                    ByteBuffer b = codec.getInputBuffer(in);
                    int n = extractor.readSampleData(b, 0);
                    if (n < 0) {
                        codec.queueInputBuffer(in, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                        inputDone = true;
                    } else {
                        lastSampleUs = extractor.getSampleTime();
                        codec.queueInputBuffer(in, 0, n, lastSampleUs, 0);
                        extractor.advance();
                    }
                }
            }
            int out = codec.dequeueOutputBuffer(info, CODEC_TIMEOUT_US);
            if (out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                MediaFormat f = codec.getOutputFormat();
                createTrack(f.getInteger(MediaFormat.KEY_SAMPLE_RATE), f.getInteger(MediaFormat.KEY_CHANNEL_COUNT), pcmEncoding(f));
            } else if (out >= 0) {
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
                if (info.size > 0) {
                    if (track == null) {
                        MediaFormat f = codec.getOutputFormat();
                        createTrack(f.getInteger(MediaFormat.KEY_SAMPLE_RATE), f.getInteger(MediaFormat.KEY_CHANNEL_COUNT), pcmEncoding(f));
                    }
                    ByteBuffer b = codec.getOutputBuffer(out);
                    b.position(info.offset);
                    b.limit(info.offset + info.size);
                    take(b, out, info.presentationTimeUs);
                } else {
                    codec.releaseOutputBuffer(out, false);
                }
            }
        }

        private void publishCache() {
            long cached = extractor.getCachedDuration();
            boolean end = extractor.hasCacheReachedEndOfStream();
            synchronized (this) {
                cachedUs = cached;
                cacheEnd = end;
            }
        }

        /** The chunk `b` (at media time `us`), in the AudioTrack's encoding, cut at a seek's target. */
        private void take(ByteBuffer b, int index, long us) {
            ByteBuffer data = b;
            if (encoding != trackEncoding) {
                data = toFloat(b);
                if (index >= 0) codec.releaseOutputBuffer(index, false);
                index = -1;
            }
            if (cutUs >= 0) {
                long frames = data.remaining() / frameBytes;
                long skip = (cutUs - us) * rate / 1_000_000;
                if (skip >= frames) {
                    if (index >= 0) codec.releaseOutputBuffer(index, false);
                    return;
                }
                if (skip > 0) {
                    data.position(data.position() + (int) skip * frameBytes);
                    us = cutUs;
                }
                cutUs = -1;
            }
            if (probe) measure(data);
            pending = data;
            pendingIndex = index;
            pendingUs = us;
        }

        /** Writes what fits of the pending chunk; false if the AudioTrack is full. */
        private boolean writePending() {
            int n = track.write(pending, pending.remaining(), AudioTrack.WRITE_NON_BLOCKING);
            if (n < 0) throw new IllegalStateException("AudioTrack.write " + n);
            if (n > 0) {
                synchronized (this) {
                    if (startUs < 0) startUs = pendingUs;
                    written += n / frameBytes;
                }
            }
            boolean full = pending.hasRemaining();
            if (!full) {
                boolean pad = padding;
                dropPending();
                if (pad) post(this, "end", PlayerEngine.this::onEnded);
            }
            prime(full);
            return !full;
        }

        private void dropPending() {
            if (pendingIndex >= 0) codec.releaseOutputBuffer(pendingIndex, false);
            pending = null;
            pendingIndex = -1;
            padding = false;
        }

        /** Tells the engine once audio is queued since the seek decoded now: PRIME_MS, a full track, or the end. */
        private void prime(boolean full) {
            int g;
            synchronized (this) {
                if (primed && primedGen == gen) return;
                if (!full && endFrames < 0 && written * 1000 / rate < PRIME_MS) return;
                primed = true;
                primedGen = gen;
                g = gen;
            }
            post(this, "primed", s -> onPrimed(s, g));
        }

        /**
         * The stream's data has ended. readSampleData answers -1 at the end and on a read error
         * alike, so D242: a direct stream whose last sample is more than CUT_OFF_US short of its
         * duration was cut off (a connection error, never "completed"); a transcode has no duration
         * and cannot be told apart. Otherwise the pad follows the last frame, and "completed" the pad.
         */
        private boolean end() {
            if (durationUs > 0 && lastSampleUs < durationUs - CUT_OFF_US) {
                report(ERROR_CONNECTION, "stream ended at " + lastSampleUs / 1000 + " of " + durationUs / 1000 + " ms");
                return false;
            }
            ended = true;
            if (probe) logLevel();
            synchronized (this) {
                endFrames = written;
            }
            if (track == null) {
                prime(true);
                post(this, "end", PlayerEngine.this::onEnded);
                return true;
            }
            // D241: an AudioTrack's position reads 0 once it is stopped, so the stream's end is not
            // a stop(). AudioFlinger starts (and restarts, after a pause) a track that is not
            // stopping only once its buffer is full, so a buffer's worth of silence follows the last
            // frame: the end plays out, even for a stream shorter than the buffer or one resumed in
            // its last moments, and the position shows when it has.
            ByteBuffer pad = ByteBuffer.allocateDirect(capacityFrames * frameBytes);
            if (trackEncoding == AudioFormat.ENCODING_PCM_8BIT) {
                while (pad.hasRemaining()) pad.put((byte) 0x80);
                pad.flip();
            }
            pending = pad;
            pendingIndex = -1;
            pendingUs = lastSampleUs;
            padding = true;
            prime(true);
            return true;
        }

        /** The AudioTrack for this format, unless the current one already is: the format's first. */
        private void createTrack(int sampleRate, int channelCount, int enc) throws Unsupported {
            int out = trackEncodingFor(enc);
            if (track != null && sampleRate == rate && channelCount == channels && enc == encoding) return;
            int mask = channelMask(channelCount);
            if (mask == 0 || sampleRate <= 0) throw new Unsupported(channelCount + " channels at " + sampleRate + " Hz");
            int bytes = channelCount * (out == AudioFormat.ENCODING_PCM_16BIT ? 2 : out == AudioFormat.ENCODING_PCM_FLOAT ? 4 : 1);
            int min = AudioTrack.getMinBufferSize(sampleRate, mask, out);
            if (min <= 0) throw new Unsupported("AudioTrack: " + describe(out, sampleRate, channelCount) + " (" + min + ")");
            int size = (int) Math.max(min, Math.min((long) sampleRate * bytes * TRACK_BUFFER_MS / 1000, MAX_TRACK_BYTES));
            AudioTrack t;
            try {
                t = new AudioTrack.Builder()
                        .setAudioAttributes(ATTRIBUTES)
                        .setAudioFormat(new AudioFormat.Builder()
                                .setEncoding(out)
                                .setSampleRate(sampleRate)
                                .setChannelMask(mask)
                                .build())
                        .setBufferSizeInBytes(size)
                        .setTransferMode(AudioTrack.MODE_STREAM)
                        .build();
            } catch (UnsupportedOperationException | IllegalArgumentException e) {
                throw new Unsupported("AudioTrack: " + describe(out, sampleRate, channelCount) + ": " + e.getMessage());
            }
            if (t.getState() != AudioTrack.STATE_INITIALIZED) {
                t.release();
                throw new Unsupported("AudioTrack: " + describe(out, sampleRate, channelCount) + " not initialized");
            }
            AudioTrack old;
            synchronized (this) {
                old = track;
                track = t;
                // A recreated track starts again once it is primed (the engine plays it).
                trackStarted = false;
                primed = false;
                rate = sampleRate;
                frameBytes = bytes;
                capacityFrames = t.getBufferSizeInFrames();
                capacityMs = capacityFrames * 1000 / sampleRate;
                written = 0;
                startUs = -1;
                // B2: a duck applies to a new track too.
                t.setVolume(volume);
            }
            if (old != null) old.release();
            encoding = enc;
            trackEncoding = out;
            channels = channelCount;
            Log.i(MainActivity.TAG, "[Sonance] player " + s.id + ": pcm " + name(enc) + " -> " + name(out) + ", "
                    + sampleRate + " Hz, " + channelCount + " ch");
        }

        /** 24-bit packed or 32-bit integer PCM, as float. */
        private ByteBuffer toFloat(ByteBuffer b) {
            boolean packed = encoding == AudioFormat.ENCODING_PCM_24BIT_PACKED;
            int count = b.remaining() / (packed ? 3 : 4);
            if (converted == null || converted.capacity() < count * 4) {
                converted = ByteBuffer.allocateDirect(count * 4).order(ByteOrder.nativeOrder());
            }
            converted.clear();
            ByteBuffer in = b.duplicate().order(ByteOrder.LITTLE_ENDIAN);
            for (int i = 0; i < count; i++) {
                if (packed) {
                    int v = (in.get() & 0xff) | ((in.get() & 0xff) << 8) | (in.get() << 16);
                    converted.putFloat(v / 8388608f);
                } else {
                    converted.putFloat(in.getInt() / 2147483648f);
                }
            }
            converted.flip();
            return converted;
        }

        /** The sine probe: the level of what the AudioTrack is given, read in the track's encoding. */
        private void measure(ByteBuffer data) {
            ByteBuffer d = data.duplicate().order(ByteOrder.nativeOrder());
            while (d.hasRemaining()) {
                double v;
                if (trackEncoding == AudioFormat.ENCODING_PCM_FLOAT) v = d.getFloat();
                else if (trackEncoding == AudioFormat.ENCODING_PCM_16BIT) v = d.getShort() / 32768.0;
                else v = ((d.get() & 0xff) - 128) / 128.0;
                peak = Math.max(peak, Math.abs(v));
                sumSquares += v * v;
                samples++;
            }
        }

        private void logLevel() {
            if (samples == 0) return;
            Log.i(MainActivity.TAG, String.format(Locale.ROOT, "[Sonance] player %d: level peak %.4f, rms %.4f (%d samples)",
                    s.id, peak, Math.sqrt(sumSquares / samples), samples));
        }

        private void releaseAll() {
            AudioTrack t;
            synchronized (this) {
                t = track;
                track = null;
                trackStarted = false;
            }
            if (t != null) t.release();
            if (codec != null) codec.release();
            if (extractor != null) extractor.release();
        }
    }

    private static int pcmEncoding(MediaFormat f) {
        return f.containsKey(MediaFormat.KEY_PCM_ENCODING) ? f.getInteger(MediaFormat.KEY_PCM_ENCODING)
                : AudioFormat.ENCODING_PCM_16BIT;
    }

    /** The AudioTrack's encoding for decoded `enc`: as it is, or float for integer PCM wider than 16 bits. */
    private static int trackEncodingFor(int enc) throws Unsupported {
        switch (enc) {
            case AudioFormat.ENCODING_PCM_8BIT:
            case AudioFormat.ENCODING_PCM_16BIT:
            case AudioFormat.ENCODING_PCM_FLOAT:
                return enc;
            case AudioFormat.ENCODING_PCM_24BIT_PACKED:
            case AudioFormat.ENCODING_PCM_32BIT:
                return AudioFormat.ENCODING_PCM_FLOAT;
            default:
                throw new Unsupported("PCM encoding " + enc);
        }
    }

    private static int channelMask(int count) {
        switch (count) {
            case 1: return AudioFormat.CHANNEL_OUT_MONO;
            case 2: return AudioFormat.CHANNEL_OUT_STEREO;
            case 3: return AudioFormat.CHANNEL_OUT_STEREO | AudioFormat.CHANNEL_OUT_FRONT_CENTER;
            case 4: return AudioFormat.CHANNEL_OUT_QUAD;
            case 5: return AudioFormat.CHANNEL_OUT_QUAD | AudioFormat.CHANNEL_OUT_FRONT_CENTER;
            case 6: return AudioFormat.CHANNEL_OUT_5POINT1;
            case 7: return AudioFormat.CHANNEL_OUT_5POINT1 | AudioFormat.CHANNEL_OUT_BACK_CENTER;
            case 8: return AudioFormat.CHANNEL_OUT_7POINT1_SURROUND;
            default: return 0;
        }
    }

    private static String name(int enc) {
        switch (enc) {
            case AudioFormat.ENCODING_PCM_8BIT: return "8-bit";
            case AudioFormat.ENCODING_PCM_16BIT: return "16-bit";
            case AudioFormat.ENCODING_PCM_24BIT_PACKED: return "24-bit";
            case AudioFormat.ENCODING_PCM_32BIT: return "32-bit";
            case AudioFormat.ENCODING_PCM_FLOAT: return "float";
            default: return "encoding " + enc;
        }
    }

    private static String describe(int enc, int rate, int channels) {
        return name(enc) + ", " + rate + " Hz, " + channels + " ch";
    }
}
