package com.shazverse.rxclinic.call

import android.content.Context
import android.content.Intent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Rx Clinic colours: deep clinical ink with surgical-scrub green. Shared by the app and the call screen. */
object Palette {
    val Bg = Color(0xFF0B1514)
    val Surface = Color(0xFF111E1D)
    val Card = Color(0xFF172826)
    val CardHigh = Color(0xFF213634)
    val Blue = Color(0xFF0E7C74)      // primary: scrub green
    val Teal = Color(0xFF5BD6C9)      // highlight
    val Red = Color(0xFFEF5350)       // Rx red, alerts
    val Amber = Color(0xFFF2BC55)
    val Text = Color(0xFFE6EFED)
    val Muted = Color(0xFF94A8A5)
}

@Composable
fun RxTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Palette.Blue,
            onPrimary = Color.White,
            secondary = Palette.Teal,
            onSecondary = Color(0xFF042F2B),
            background = Palette.Bg,
            onBackground = Palette.Text,
            surface = Palette.Surface,
            onSurface = Palette.Text,
            surfaceVariant = Palette.Card,
            onSurfaceVariant = Palette.Muted,
            surfaceContainer = Palette.Surface,
            surfaceContainerHigh = Palette.Card,
            surfaceContainerHighest = Palette.CardHigh,
            error = Palette.Red,
            outline = Color(0xFF2E4542),
        ),
        content = content,
    )
}

fun shareText(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
    context.startActivity(Intent.createChooser(send, "Share"))
}
