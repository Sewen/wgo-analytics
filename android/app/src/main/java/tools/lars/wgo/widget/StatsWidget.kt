package tools.lars.wgo.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.DateFormat
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.CircularProgressIndicator
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.state.GlanceStateDefinition
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import tools.lars.wgo.R
import tools.lars.wgo.data.Account
import tools.lars.wgo.data.AccountStore
import tools.lars.wgo.data.WidgetStat
import tools.lars.wgo.ui.ConfigActivity
import tools.lars.wgo.ui.MainActivity
import java.util.Date
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

class StatsWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact
    override val stateDefinition: GlanceStateDefinition<*> = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        provideContent {
            val prefs = currentState<Preferences>()
            val config = WidgetStore.config(prefs)
            val data = WidgetStore.data(prefs)
            val pal = Palette.forTheme(context, config?.theme ?: "auto", config?.opacity ?: 100)
            Content(appWidgetId, config, data, AccountStore.get(context), pal)
        }
    }
}

private const val PAD = 12f
private const val GAP = 8f
private const val HEADER = 44f // header row + gap below it

/** Everything a layout needs, resolved once per composition. */
private class Ui(
    val ctx: Context,
    val pal: Palette,
    val appWidgetId: Int,
    val config: WidgetConfig,
    val data: WidgetData,
    val account: Account,
) {
    fun configure(): Action = actionStartActivity(
        Intent(ctx, ConfigActivity::class.java)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
            .setData(Uri.parse("wgo://configure/$appWidgetId")) // distinct PendingIntent per widget
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
    )

    fun open(page: String): Action {
        val dash = account.dashUrl
        if (dash.isBlank()) return actionStartActivity(Intent(ctx, MainActivity::class.java))
        val url = "$dash/#/p/${Uri.encode(config.projectId)}/$page?range=${config.range}"
        return actionStartActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

@Composable
private fun Content(appWidgetId: Int, config: WidgetConfig?, data: WidgetData, account: Account?, pal: Palette) {
    val ctx = LocalContext.current
    Box(
        modifier = GlanceModifier.fillMaxSize().appWidgetBackground().background(pal.bg).cornerRadius(24.dp).padding(PAD.dp),
    ) {
        when {
            config == null -> Prompt(
                pal, "Set up widget", "Pick a project and the stats you want to see",
                actionStartActivity(
                    Intent(ctx, ConfigActivity::class.java)
                        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                        .setData(Uri.parse("wgo://configure/$appWidgetId"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
                ),
            )
            account == null || data.errorKind == "auth" -> Prompt(
                pal,
                if (account == null) "Connect WGO" else "Device disconnected",
                "Tap to pair this phone with your dashboard",
                actionStartActivity(Intent(ctx, MainActivity::class.java)),
            )
            else -> Body(Ui(ctx, pal, appWidgetId, config, data, account))
        }
    }
}

@Composable
private fun Body(ui: Ui) {
    val size = LocalSize.current
    val w = size.width.value - 2 * PAD
    val h = size.height.value - 2 * PAD
    val stats = ui.data.summary?.stats
    if (stats.isNullOrEmpty()) {
        Column(GlanceModifier.fillMaxSize()) {
            if (h >= 70) Header(ui, compact = w < 160)
            Box(GlanceModifier.fillMaxSize().clickable(actionRunCallback<RefreshAction>()), contentAlignment = Alignment.Center) {
                val err = ui.data.error
                Text(
                    if (err != null && !ui.data.refreshing) "$err · tap to retry" else "Loading…",
                    style = TextStyle(color = ui.pal.p(if (err != null) ui.pal.warn else ui.pal.muted), fontSize = 12.sp),
                )
            }
        }
        return
    }
    when {
        w < 170 && h < 200 -> Compact(ui, stats, w, h)
        w < 170 -> Tall(ui, stats, w, h)
        // a board needs room for the hero chart plus at least one row of tiles
        h < 250 -> Strip(ui, stats, w, h)
        else -> Board(ui, stats, w, h)
    }
}

// ------------------------------------------------------------------ layouts

/** 2×1 / 2×2: the first stat, big. */
@Composable
private fun Compact(ui: Ui, stats: List<WidgetStat>, w: Float, h: Float) {
    Column(GlanceModifier.fillMaxSize()) {
        val showHeader = h >= 120
        if (showHeader) Header(ui, compact = true)
        Hero(ui, stats.first(), w, if (showHeader) h - HEADER else h, bare = true, size = GlanceModifier.fillMaxWidth().defaultWeight())
    }
}

/** Narrow and tall: a list, one stat per row. */
@Composable
private fun Tall(ui: Ui, stats: List<WidgetStat>, w: Float, h: Float) {
    val rowH = 50f
    val fit = max(1, floor((h * 0.92f - HEADER + GAP) / (rowH + GAP)).toInt()) // reported height runs a little large
    Column(GlanceModifier.fillMaxSize()) {
        Header(ui, compact = true)
        stats.take(fit).forEachIndexed { i, s ->
            if (i > 0) Spacer(GlanceModifier.height(GAP.dp))
            ListRow(ui, s, w, rowH)
        }
    }
}

/** Wide and short (4×1, 4×2 on most launchers): a row of tiles. */
@Composable
private fun Strip(ui: Ui, stats: List<WidgetStat>, w: Float, h: Float) {
    val showHeader = h >= 110
    val tileH = if (showHeader) h - HEADER else h
    val n = min(stats.size, max(1, floor((w + GAP) / (92f + GAP)).toInt()))
    val tileW = (w - GAP * (n - 1)) / n
    Column(GlanceModifier.fillMaxSize()) {
        if (showHeader) Header(ui, compact = false)
        // weighted, not tileH: launchers report a slightly larger size than they lay out
        Row(GlanceModifier.fillMaxWidth().defaultWeight()) {
            stats.take(n).forEachIndexed { i, s ->
                if (i > 0) Spacer(GlanceModifier.width(GAP.dp))
                Tile(ui, s, tileW, tileH, GlanceModifier.defaultWeight())
            }
        }
    }
}

/** 4×3 and up: a hero stat with a large chart, then a grid. */
@Composable
private fun Board(ui: Ui, stats: List<WidgetStat>, w: Float, h: Float) {
    val cols = if (w >= 330) 3 else 2
    val rest = stats.drop(1)
    val minHero = 104f
    val minTile = 68f
    val rowsFit = floor((h - HEADER - minHero) / (minTile + GAP)).toInt().coerceAtLeast(0)
    val rows = min(rowsFit, (rest.size + cols - 1) / cols)
    // give the hero up to 46% of the height and share what is left between the tile rows
    val heroH = if (rows == 0) h - HEADER else max(minHero, min((h - HEADER) * 0.46f, h - HEADER - rows * (minTile + GAP)))
    val tileH = if (rows == 0) 0f else (h - HEADER - heroH) / rows - GAP
    val tileW = (w - GAP * (cols - 1)) / cols
    Column(GlanceModifier.fillMaxSize()) {
        Header(ui, compact = false)
        Hero(ui, stats.first(), w, heroH, bare = false)
        for (r in 0 until rows) {
            Spacer(GlanceModifier.height(GAP.dp))
            Row(GlanceModifier.fillMaxWidth().defaultWeight()) {
                for (c in 0 until cols) {
                    if (c > 0) Spacer(GlanceModifier.width(GAP.dp))
                    val s = rest.getOrNull(r * cols + c)
                    if (s != null) Tile(ui, s, tileW, tileH, GlanceModifier.defaultWeight())
                    else Spacer(GlanceModifier.defaultWeight())
                }
            }
        }
    }
}

// ------------------------------------------------------------------ pieces

@Composable
private fun Header(ui: Ui, compact: Boolean) {
    val pal = ui.pal
    val data = ui.data
    val time = if (data.updatedAt > 0) DateFormat.getTimeFormat(ui.ctx).format(Date(data.updatedAt)) else null
    val sub = when {
        data.error != null -> listOfNotNull(data.error, time).joinToString(" · ")
        compact -> time ?: ui.config.range
        else -> listOfNotNull(Fmt.rangeLabel(ui.config.range), time?.let { "updated $it" }).joinToString(" · ")
    }
    Column(GlanceModifier.fillMaxWidth().height(HEADER.dp)) {
        Row(GlanceModifier.fillMaxWidth().height((HEADER - 8).dp), verticalAlignment = Alignment.CenterVertically) { // 2 text lines
            Image(ImageProvider(R.drawable.ic_wgo_mark), contentDescription = null, modifier = GlanceModifier.size(if (compact) 16.dp else 20.dp))
            Spacer(GlanceModifier.width(8.dp))
            Column(GlanceModifier.defaultWeight().clickable(ui.configure())) {
                Text(
                    ui.data.summary?.project?.name ?: ui.config.projectName,
                    maxLines = 1,
                    style = TextStyle(color = pal.p(pal.text), fontSize = if (compact) 11.sp else 13.sp, fontWeight = FontWeight.Bold),
                )
                Text(
                    sub,
                    maxLines = 1,
                    style = TextStyle(color = pal.p(if (data.error != null) pal.warn else pal.faint), fontSize = 10.sp),
                )
            }
            Box(
                GlanceModifier.size(28.dp).cornerRadius(14.dp).clickable(actionRunCallback<RefreshAction>()),
                contentAlignment = Alignment.Center,
            ) {
                if (data.refreshing) CircularProgressIndicator(GlanceModifier.size(14.dp), color = pal.p(pal.accent))
                else Image(
                    ImageProvider(R.drawable.ic_refresh), contentDescription = "Refresh",
                    modifier = GlanceModifier.size(16.dp), colorFilter = ColorFilter.tint(pal.p(pal.muted)),
                )
            }
        }
    }
}

@Composable
private fun Hero(ui: Ui, s: WidgetStat, w: Float, h: Float, bare: Boolean, size: GlanceModifier = GlanceModifier.fillMaxWidth().height(h.dp)) {
    val pal = ui.pal
    val inner = if (bare) 0f else 12f
    val modifier = size.clickable(ui.open(s.page))
    Column(if (bare) modifier else modifier.background(pal.tile).cornerRadius(18.dp).padding(horizontal = inner.dp, vertical = 10.dp)) {
        LabelRow(ui, s, big = true)
        if (s.unit == "text") {
            Text(Fmt.text(s), maxLines = 2, style = TextStyle(color = pal.p(pal.text), fontSize = 20.sp, fontWeight = FontWeight.Bold))
            Fmt.textDetail(s)?.let { Text(it, style = TextStyle(color = pal.p(pal.muted), fontSize = 12.sp)) }
        } else {
            val big = if (h >= 120) 34.sp else if (h >= 80) 28.sp else 22.sp
            Text(Fmt.value(s), maxLines = 1, style = TextStyle(color = pal.p(ratingOr(pal, s)), fontSize = big, fontWeight = FontWeight.Bold))
            val sparkH = h - (if (bare) 0f else 20f) - 18f - big.value * 1.3f - 4f
            Spark(ui, s, w - 2 * inner, sparkH)
        }
    }
}

@Composable
private fun Tile(ui: Ui, s: WidgetStat, w: Float, h: Float, modifier: GlanceModifier) {
    val pal = ui.pal
    Column(
        modifier.fillMaxHeight().background(pal.tile).cornerRadius(16.dp).padding(horizontal = 10.dp, vertical = 8.dp).clickable(ui.open(s.page)),
    ) {
        LabelRow(ui, s, big = false, delta = false) // the delta sits by the value, so the label gets the full width
        if (s.unit == "text") {
            Text(Fmt.text(s), maxLines = 1, style = TextStyle(color = pal.p(pal.text), fontSize = 14.sp, fontWeight = FontWeight.Bold))
            Fmt.textDetail(s)?.let { Text(it, maxLines = 1, style = TextStyle(color = pal.p(pal.faint), fontSize = 10.5.sp)) }
        } else {
            val size = if (w >= 110) 20.sp else 17.sp
            Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    Fmt.value(s), maxLines = 1, modifier = GlanceModifier.defaultWeight(),
                    style = TextStyle(color = pal.p(ratingOr(pal, s)), fontSize = size, fontWeight = FontWeight.Bold),
                )
                Fmt.delta(s)?.let { DeltaChip(pal, it) }
            }
            Spark(ui, s, w - 20, h - 16 - 16 - size.value * 1.3f - 2)
        }
    }
}

@Composable
private fun ListRow(ui: Ui, s: WidgetStat, w: Float, h: Float) {
    val pal = ui.pal
    Row(
        GlanceModifier.fillMaxWidth().height(h.dp).background(pal.tile).cornerRadius(14.dp).padding(horizontal = 10.dp).clickable(ui.open(s.page)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(GlanceModifier.defaultWeight()) {
            Text(s.label, maxLines = 1, style = TextStyle(color = pal.p(pal.muted), fontSize = 10.5.sp))
            Text(
                if (s.unit == "text") Fmt.text(s) else Fmt.value(s), maxLines = 1,
                style = TextStyle(color = pal.p(ratingOr(pal, s)), fontSize = 16.sp, fontWeight = FontWeight.Bold),
            )
        }
        Fmt.delta(s)?.let { DeltaChip(pal, it) }
        if (s.unit != "text" && w >= 150 && s.series.size >= 2) {
            Sparkline.render(ui.ctx, s.series, 40f, 22f, ui.pal.spark(s.key, s.rating, s.better), zeroBased = s.unit == "count")?.let {
                Spacer(GlanceModifier.width(6.dp))
                Image(ImageProvider(it), contentDescription = null, modifier = GlanceModifier.size(40.dp, 22.dp), contentScale = ContentScale.FillBounds)
            }
        }
    }
}

@Composable
private fun LabelRow(ui: Ui, s: WidgetStat, big: Boolean, delta: Boolean = true) {
    val pal = ui.pal
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        if (s.key == "visitors_now") {
            Image(
                ImageProvider(R.drawable.dot), contentDescription = null,
                modifier = GlanceModifier.size(7.dp), colorFilter = ColorFilter.tint(pal.p(pal.good)),
            )
            Spacer(GlanceModifier.width(5.dp))
        }
        Text(
            s.label, maxLines = 1, modifier = GlanceModifier.defaultWeight(),
            style = TextStyle(color = pal.p(pal.muted), fontSize = if (big) 12.sp else 10.5.sp, fontWeight = FontWeight.Medium),
        )
        when {
            s.key == "visitors_now" && big -> Text("LIVE", style = TextStyle(color = pal.p(pal.good), fontSize = 9.5.sp, fontWeight = FontWeight.Bold))
            delta -> Fmt.delta(s)?.let { DeltaChip(pal, it) }
        }
    }
}

@Composable
private fun DeltaChip(pal: Palette, d: Fmt.Delta) {
    val c = pal.tone(d.tone)
    Box(GlanceModifier.background(c.copy(alpha = 0.16f)).cornerRadius(6.dp).padding(horizontal = 5.dp, vertical = 1.dp)) {
        Text(d.label, maxLines = 1, style = TextStyle(color = pal.p(c), fontSize = 9.5.sp, fontWeight = FontWeight.Bold))
    }
}

/**
 * Takes the remaining height of its column (defaultWeight), so it can never push past the tile's padding,
 * whatever the launcher's real cell size is. [h] only sizes the bitmap.
 */
@Composable
private fun ColumnScope.Spark(ui: Ui, s: WidgetStat, w: Float, h: Float) {
    if (h < 12 || s.series.size < 2) return
    val bmp = Sparkline.render(
        ui.ctx, s.series, w, h, ui.pal.spark(s.key, s.rating, s.better),
        zeroBased = s.unit == "count",
    ) ?: return
    Spacer(GlanceModifier.height(4.dp))
    Image(
        ImageProvider(bmp), contentDescription = null,
        modifier = GlanceModifier.fillMaxWidth().defaultWeight(), contentScale = ContentScale.FillBounds,
    )
}

@Composable
private fun Prompt(pal: Palette, title: String, body: String, action: Action) {
    Column(
        GlanceModifier.fillMaxSize().clickable(action),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Image(ImageProvider(R.drawable.ic_wgo_mark), contentDescription = null, modifier = GlanceModifier.size(28.dp))
        Spacer(GlanceModifier.height(8.dp))
        Text(title, maxLines = 1, style = TextStyle(color = pal.p(pal.text), fontSize = 14.sp, fontWeight = FontWeight.Bold))
        Text(body, maxLines = 2, style = TextStyle(color = pal.p(pal.muted), fontSize = 11.sp))
    }
}

private fun ratingOr(pal: Palette, s: WidgetStat): Color = pal.rating(s.rating) ?: pal.text
