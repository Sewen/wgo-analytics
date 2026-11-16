package tools.lars.wgo.widget

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Widgets can't draw paths, so sparklines are rendered to small bitmaps. RemoteViews caps total bitmap
 * memory, so the size is clamped and kept to roughly the on-screen pixels.
 */
object Sparkline {
    private const val MAX_W = 720
    private const val MAX_H = 240

    fun render(
        context: Context,
        series: List<Double>,
        widthDp: Float,
        heightDp: Float,
        colors: IntArray,
        zeroBased: Boolean,
    ): Bitmap? {
        if (series.size < 2 || widthDp < 8 || heightDp < 8) return null
        val d = context.resources.displayMetrics.density
        val w = min((widthDp * d).roundToInt(), MAX_W)
        val h = min((heightDp * d).roundToInt(), MAX_H)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)

        val stroke = 2f * d
        val pad = stroke + 2f * d // room for the end dot
        val lo = if (zeroBased) min(0.0, series.min()) else series.min()
        val hi = series.max()
        val span = if (hi - lo == 0.0) 1.0 else hi - lo
        val flat = hi == lo
        val xs = FloatArray(series.size) { i -> pad + i * (w - 2 * pad) / (series.size - 1) }
        val ys = FloatArray(series.size) { i ->
            if (flat) (if (zeroBased && hi == 0.0) h - pad else h / 2f)
            else (h - pad - ((series[i] - lo) / span * (h - 2 * pad))).toFloat()
        }

        // Catmull-Rom → cubic Bézier, with control points clamped to the plot so peaks don't overshoot
        val line = Path().apply {
            moveTo(xs[0], ys[0])
            for (i in 0 until xs.size - 1) {
                val x0 = xs[max(i - 1, 0)]; val y0 = ys[max(i - 1, 0)]
                val x3 = xs[min(i + 2, xs.size - 1)]; val y3 = ys[min(i + 2, ys.size - 1)]
                val c1x = xs[i] + (xs[i + 1] - x0) / 6f
                val c1y = (ys[i] + (ys[i + 1] - y0) / 6f).coerceIn(pad, h - pad)
                val c2x = xs[i + 1] - (x3 - xs[i]) / 6f
                val c2y = (ys[i + 1] - (y3 - ys[i]) / 6f).coerceIn(pad, h - pad)
                cubicTo(c1x, c1y, c2x, c2y, xs[i + 1], ys[i + 1])
            }
        }
        val fill = Path(line).apply {
            lineTo(xs.last(), h.toFloat())
            lineTo(xs.first(), h.toFloat())
            close()
        }

        val start = colors[0]
        val end = colors.getOrElse(1) { start }
        canvas.drawPath(fill, Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = LinearGradient(0f, 0f, 0f, h.toFloat(), withAlpha(start, 0x55), withAlpha(start, 0x00), Shader.TileMode.CLAMP)
        })
        canvas.drawPath(line, Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = stroke
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
            shader = LinearGradient(0f, 0f, w.toFloat(), 0f, start, end, Shader.TileMode.CLAMP)
        })
        // the latest point, with a soft halo
        val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = withAlpha(end, 0x44) }
        canvas.drawCircle(xs.last(), ys.last(), 4.5f * d, dot)
        dot.color = end
        canvas.drawCircle(xs.last(), ys.last(), 2.4f * d, dot)
        return bmp
    }

    private fun withAlpha(c: Int, a: Int) = (c and 0x00FFFFFF) or (a shl 24)
}
