package com.shazverse.rxclinic.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Light clinic look (same as the Rx Clinic web preview): paper white, ink text, surgical-scrub green, Rx red. */
object Ui {
    val Bg = Color(0xFFF4F7F6)
    val Surface = Color(0xFFFFFFFF)
    val Card = Color(0xFFFFFFFF)
    val CardHigh = Color(0xFFE8EFED)
    val Line = Color(0xFFD6E0DD)
    val Blue = Color(0xFF0E6A64)     // primary: scrub green
    val Teal = Color(0xFF0E6A64)     // accent text
    val TealSoft = Color(0xFFDFEEEB)
    val Red = Color(0xFFB3261E)
    val Amber = Color(0xFF8F5A00)
    val Green = Color(0xFF24734A)
    val Text = Color(0xFF14201F)
    val Muted = Color(0xFF5A6B68)
    val Ai = Color(0xFF4447A3)
    val AiSoft = Color(0xFFEDEEFA)
}

@Composable
fun RxLightTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Ui.Blue, onPrimary = Color.White,
            secondary = Ui.Teal, onSecondary = Color.White,
            background = Ui.Bg, onBackground = Ui.Text,
            surface = Ui.Surface, onSurface = Ui.Text,
            surfaceVariant = Ui.CardHigh, onSurfaceVariant = Ui.Muted,
            surfaceContainer = Ui.Surface, surfaceContainerHigh = Ui.Surface, surfaceContainerHighest = Ui.CardHigh,
            error = Ui.Red, outline = Ui.Line,
        ),
        content = content,
    )
}
