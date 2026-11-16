package tools.lars.wgo.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tools.lars.wgo.R

object Brand {
    val bg = Color(0xFF0A0A0F)
    val raised = Color(0xFF14141C)
    val tile = Color(0xFF1A1A24)
    val line = Color(0x14FFFFFF)
    val lineStrong = Color(0x29FFFFFF)
    val fg = Color(0xFFF0EFEC)
    val muted = Color(0xFFA3A2B0)
    val faint = Color(0xFF6C6B7A)
    val accent = Color(0xFF8B7CF6)
    val accent2 = Color(0xFF22D3EE)
    val good = Color(0xFF34D399)
    val warn = Color(0xFFFBBF24)
    val bad = Color(0xFFF87171)
    val gradient = Brush.linearGradient(listOf(accent, accent2))
}

@Composable
fun WgoTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Brand.accent,
            onPrimary = Color.White,
            secondary = Brand.accent2,
            background = Brand.bg,
            onBackground = Brand.fg,
            surface = Brand.raised,
            onSurface = Brand.fg,
            surfaceVariant = Brand.tile,
            onSurfaceVariant = Brand.muted,
            surfaceContainer = Brand.raised,
            surfaceContainerHigh = Brand.tile,
            outline = Brand.lineStrong,
            outlineVariant = Brand.line,
            error = Brand.bad,
        ),
        content = content,
    )
}

@Composable
fun BrandMark(size: Int = 36) {
    Image(painterResource(R.drawable.ic_wgo_mark), contentDescription = null, modifier = Modifier.size(size.dp))
}

@Composable
fun BrandHeader(subtitle: String? = "What's going on?") {
    Row(verticalAlignment = Alignment.CenterVertically) {
        BrandMark(40)
        Spacer(Modifier.width(12.dp))
        Column {
            Text("WGO", style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Bold, brush = Brand.gradient))
            if (subtitle != null) Text(subtitle, color = Brand.muted, fontSize = 13.sp)
        }
    }
}

/** Glass card like the dashboard's. */
@Composable
fun Panel(modifier: Modifier = Modifier, padding: PaddingValues = PaddingValues(16.dp), content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(Brand.raised)
            .border(BorderStroke(1.dp, Brand.line), RoundedCornerShape(18.dp))
            .padding(padding),
        content = content,
    )
}

@Composable
fun SectionTitle(text: String, sub: String? = null) {
    Text(text, color = Brand.fg, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
    if (sub != null) Text(sub, color = Brand.faint, fontSize = 12.5.sp, modifier = Modifier.padding(top = 2.dp))
    Spacer(Modifier.height(12.dp))
}

@Composable
fun GradientButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, icon: (@Composable RowScope.() -> Unit)? = null) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.height(50.dp),
        shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent, disabledContainerColor = Color.Transparent),
        contentPadding = PaddingValues(0.dp),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(50.dp)
                .background(if (enabled) Brand.gradient else Brush.linearGradient(listOf(Brand.tile, Brand.tile)), RoundedCornerShape(14.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                icon?.invoke(this)
                if (icon != null) Spacer(Modifier.width(8.dp))
                Text(text, color = if (enabled) Color.White else Brand.faint, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            }
        }
    }
}

@Composable
fun StatusDot(color: Color) {
    Box(Modifier.size(8.dp).clip(RoundedCornerShape(4.dp)).background(color))
}
