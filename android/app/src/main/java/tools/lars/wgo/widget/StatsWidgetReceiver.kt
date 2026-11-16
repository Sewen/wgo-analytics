package tools.lars.wgo.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import tools.lars.wgo.data.WgoJson

class StatsWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = StatsWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        Scheduler.schedulePeriodic(context)
    }

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        Scheduler.schedulePeriodic(context) // KEEP: no-op when already scheduled; restores it after app updates
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        Scheduler.cancelPeriodic(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action != ACTION_PINNED) return
        // A widget pinned from inside the app: apply the config the app chose, then load it.
        val appWidgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        val json = intent.getStringExtra(EXTRA_CONFIG)
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID || json == null) return
        val config = runCatching { WgoJson.decodeFromString<WidgetConfig>(json) }.getOrNull() ?: return
        val pending = goAsync()
        CoroutineScope(Dispatchers.Default).launch {
            try {
                WidgetStore.glanceId(context, appWidgetId)?.let { id ->
                    WidgetStore.saveConfig(context, id, config)
                    StatsWidget().update(context, id)
                }
                Scheduler.refreshNow(context, appWidgetId)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_PINNED = "tools.lars.wgo.action.WIDGET_PINNED"
        private const val EXTRA_CONFIG = "config"

        /** Ask the launcher to add a widget, pre-configured with [config]. Returns false if unsupported. */
        fun requestPin(context: Context, config: WidgetConfig): Boolean {
            val mgr = AppWidgetManager.getInstance(context)
            if (!mgr.isRequestPinAppWidgetSupported) return false
            val callback = Intent(context, StatsWidgetReceiver::class.java)
                .setAction(ACTION_PINNED)
                .putExtra(EXTRA_CONFIG, WgoJson.encodeToString(WidgetConfig.serializer(), config))
            // mutable: the launcher fills in EXTRA_APPWIDGET_ID
            val pi = PendingIntent.getBroadcast(context, 0, callback, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            return mgr.requestPinAppWidget(ComponentName(context, StatsWidgetReceiver::class.java), null, pi)
        }
    }
}
