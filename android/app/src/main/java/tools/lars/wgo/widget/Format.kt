package tools.lars.wgo.widget

import tools.lars.wgo.data.WidgetStat
import java.text.NumberFormat
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

object Fmt {
    private val grouped get() = NumberFormat.getIntegerInstance()

    fun compact(n: Double): String {
        val a = abs(n)
        return when {
            a < 10_000 -> if (n == n.toLong().toDouble()) grouped.format(n.toLong()) else decimals(n)
            a < 1_000_000 -> trim(n / 1_000, if (a < 100_000) 1 else 0) + "k"
            a < 1_000_000_000 -> trim(n / 1_000_000, 1) + "M"
            else -> trim(n / 1_000_000_000, 1) + "B"
        }
    }

    private fun decimals(n: Double): String = trim(n, if (abs(n) < 10) 2 else 1)

    private fun trim(n: Double, digits: Int): String =
        NumberFormat.getNumberInstance().apply { maximumFractionDigits = digits; minimumFractionDigits = 0 }.format(n)

    fun ms(v: Double): String = when {
        v < 1 -> trim(v, 2) + " ms"
        v < 1000 -> "${v.roundToInt()} ms"
        v < 60_000 -> trim(v / 1000, 2) + " s"
        else -> trim(v / 60_000, 1) + " min"
    }

    /** The main number of a stat, e.g. "12.4k", "843 ms", "0.052". */
    fun value(s: WidgetStat): String {
        if (s.unit == "text") return text(s)
        val v = s.value ?: return "–"
        return when (s.unit) {
            "ms" -> ms(v)
            "score" -> (if (s.key == "cls") String.format(Locale.US, "%.3f", v) else compact(v)) + (s.suffix?.let { " $it" } ?: "")
            else -> compact(v)
        }
    }

    fun text(s: WidgetStat): String {
        val t = s.text ?: return "–"
        return if (s.key == "top_country") "${flag(t)} ${Locale("", t).displayCountry.ifBlank { t }}" else t
    }

    /** Secondary line for text stats: "1,204 views". */
    fun textDetail(s: WidgetStat): String? {
        val v = s.value ?: return null
        return compact(v) + if (s.key == "top_page") " views" else " sessions"
    }

    fun flag(cc: String): String =
        if (cc.length != 2) cc else cc.uppercase().map { Character.toChars(0x1F1E6 + (it - 'A')).concatToString() }.joinToString("")

    enum class Tone { GOOD, BAD, NEUTRAL }

    data class Delta(val label: String, val tone: Tone)

    /** Change versus the previous window, coloured by which direction is good. Null when not comparable. */
    fun delta(s: WidgetStat): Delta? {
        val v = s.value ?: return null
        val p = s.previous ?: return null
        if (s.unit == "text") return null
        if (p == 0.0) return if (v == 0.0) null else Delta("new", if (s.better == "down") Tone.BAD else if (s.better == "up") Tone.GOOD else Tone.NEUTRAL)
        val pct = (v - p) / abs(p) * 100
        if (abs(pct) < 0.5) return Delta("±0%", Tone.NEUTRAL)
        val shown = if (abs(pct) >= 1000) "${(pct / 100).roundToInt()}×" else "${abs(pct).roundToInt()}%"
        val up = pct > 0
        val tone = when (s.better) {
            "up" -> if (up) Tone.GOOD else Tone.BAD
            "down" -> if (up) Tone.BAD else Tone.GOOD
            else -> Tone.NEUTRAL
        }
        return Delta((if (up) "▲ " else "▼ ") + shown, tone)
    }

    fun rangeLabel(r: String) = when (r) {
        "1h" -> "Last hour"
        "24h" -> "Last 24h"
        "7d" -> "Last 7 days"
        "30d" -> "Last 30 days"
        else -> r
    }
}
