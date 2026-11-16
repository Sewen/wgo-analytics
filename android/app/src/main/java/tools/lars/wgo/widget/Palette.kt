package tools.lars.wgo.widget

import android.content.Context
import android.content.res.Configuration
import android.os.Build
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.glance.unit.ColorProvider

/** Widget colours. Matches the dashboard's dark and light themes (dashboard/src/index.css). */
data class Palette(
    val bg: Color,
    val tile: Color,
    val text: Color,
    val muted: Color,
    val faint: Color,
    val accent: Color,
    val accent2: Color,
    val good: Color,
    val warn: Color,
    val bad: Color,
    val dark: Boolean,
) {
    fun p(c: Color) = ColorProvider(c)
    fun tone(t: Fmt.Tone) = when (t) {
        Fmt.Tone.GOOD -> good
        Fmt.Tone.BAD -> bad
        Fmt.Tone.NEUTRAL -> muted
    }

    fun rating(r: String?) = when (r) {
        "good" -> good
        "warn" -> warn
        "bad" -> bad
        else -> null
    }

    /** Sparkline gradient for a stat: brand violet→cyan, red for error counts, rating colour for vitals. */
    fun spark(statKey: String, rating: String?, better: String): IntArray {
        rating(rating)?.let { return intArrayOf(it.toArgb(), it.toArgb()) }
        if (better == "down" && statKey !in setOf("latency_p95")) return intArrayOf(bad.toArgb(), Color(0xFFFB923C).toArgb())
        return intArrayOf(accent.toArgb(), accent2.toArgb())
    }

    companion object {
        private val DARK = Palette(
            bg = Color(0xFF0E0E15), tile = Color(0xFF1A1A24), text = Color(0xFFF0EFEC), muted = Color(0xFFA3A2B0),
            faint = Color(0xFF6C6B7A), accent = Color(0xFF8B7CF6), accent2 = Color(0xFF22D3EE), good = Color(0xFF34D399),
            warn = Color(0xFFFBBF24), bad = Color(0xFFF87171), dark = true,
        )
        private val LIGHT = Palette(
            bg = Color(0xFFFDFDFE), tile = Color(0xFFF1F0F7), text = Color(0xFF0E0E14), muted = Color(0xFF52514E),
            faint = Color(0xFF8A8996), accent = Color(0xFF6250D6), accent2 = Color(0xFF0891B2), good = Color(0xFF059669),
            warn = Color(0xFFB45309), bad = Color(0xFFDC2626), dark = false,
        )

        fun isNight(context: Context) =
            (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

        fun forTheme(context: Context, theme: String, opacity: Int): Palette {
            val night = isNight(context)
            val base = when (theme) {
                "dark" -> DARK
                "light" -> LIGHT
                "system" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) materialYou(context, night) else if (night) DARK else LIGHT
                else -> if (night) DARK else LIGHT
            }
            val a = opacity.coerceIn(30, 100) / 100f
            return base.copy(bg = base.bg.copy(alpha = a), tile = base.tile.copy(alpha = (a + 0.05f).coerceAtMost(1f)))
        }

        private fun materialYou(context: Context, night: Boolean): Palette {
            fun c(id: Int) = Color(context.getColor(id))
            val base = if (night) DARK else LIGHT
            return if (night) base.copy(
                bg = c(android.R.color.system_neutral1_900),
                tile = c(android.R.color.system_neutral2_800),
                text = c(android.R.color.system_neutral1_50),
                muted = c(android.R.color.system_neutral2_200),
                faint = c(android.R.color.system_neutral2_400),
                accent = c(android.R.color.system_accent1_200),
                accent2 = c(android.R.color.system_accent3_200),
            ) else base.copy(
                bg = c(android.R.color.system_neutral1_10),
                tile = c(android.R.color.system_accent2_50),
                text = c(android.R.color.system_neutral1_900),
                muted = c(android.R.color.system_neutral2_700),
                faint = c(android.R.color.system_neutral2_500),
                accent = c(android.R.color.system_accent1_600),
                accent2 = c(android.R.color.system_accent3_500),
            )
        }
    }
}
