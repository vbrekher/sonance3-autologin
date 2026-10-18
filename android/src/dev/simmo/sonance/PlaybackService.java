package dev.simmo.sonance;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * B1: the mediaPlayback foreground service that keeps Sonance playing after the user leaves it
 * (ticket-3.xx-androidtv G4). It holds no player: PlayerEngine plays in this process, and the
 * service only marks the process as playing media, with a low-importance notification ("Sonance",
 * and the track's title). The activity starts it on the first play while it is visible (a
 * background start throws on Android 12+) and stops it on exit, renderer loss and its own end.
 *
 * Every method here runs on the main thread, as the activity's and the service's callbacks do,
 * so the static state needs no lock.
 */
public final class PlaybackService extends Service {
    private static final String CHANNEL = "playback";
    private static final int NOTIFICATION_ID = 1;

    private static String title = "";
    private static PlaybackService running;

    /** Call only while the activity is visible. */
    static void start(Context context) {
        context.startForegroundService(new Intent(context, PlaybackService.class));
    }

    /** Returns whether a service was running. */
    static boolean stop(Context context) {
        return context.stopService(new Intent(context, PlaybackService.class));
    }

    /**
     * The current track's title, or "" for none. A running service's notification is updated
     * with NotificationManager.notify (same id): a second startForeground from the background may
     * be refused on Android 12+.
     */
    static void setTitle(String trackTitle) {
        title = trackTitle == null ? "" : trackTitle;
        if (running != null) {
            running.getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, running.notification());
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification());
        }
        Log.i(MainActivity.TAG, "[Sonance] service: in the foreground");
        // Never restarted by the system: a new process has no page to play for.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = null;
        Log.i(MainActivity.TAG, "[Sonance] service: stopped");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification notification() {
        Notification.Builder b = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentTitle("Sonance")
                .setOngoing(true)
                .setShowWhen(false);
        if (!title.isEmpty()) b.setContentText(title);
        return b.build();
    }
}
