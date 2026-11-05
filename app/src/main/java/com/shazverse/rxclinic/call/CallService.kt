package com.shazverse.rxclinic.call

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.shazverse.rxclinic.MainActivity
import com.shazverse.rxclinic.R

/** Keeps the call (and your microphone) alive while the app is in the background. */
class CallService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Ongoing teleconsult", NotificationManager.IMPORTANCE_LOW)
        )
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle("Rx Clinic")
            .setContentText("You're in a teleconsult. Tap to return.")
            .setOngoing(true)
            .setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .build()
        try {
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
        } catch (e: Exception) {
            stopSelf()
        }
        return START_NOT_STICKY
    }

    companion object {
        private const val CHANNEL = "meeting"
        private const val NOTIFICATION_ID = 42

        fun start(context: Context) {
            runCatching { ContextCompat.startForegroundService(context, Intent(context, CallService::class.java)) }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, CallService::class.java)) }
        }
    }
}
