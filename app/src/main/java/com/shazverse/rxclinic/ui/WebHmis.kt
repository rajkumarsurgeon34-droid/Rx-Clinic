package com.shazverse.rxclinic.ui

import android.annotation.SuppressLint
import android.net.Uri
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.shazverse.rxclinic.call.CallViewModel

/** The HMIS web workspace (dashboard and patient chart) inside the app, already signed in. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun HmisWebScreen(vm: CallViewModel, start: String = "", onBack: () -> Unit) {
    val role = vm.prefs.staffRole
    val session = role?.let { vm.prefs.session(it) } ?: run { LaunchedEffect(Unit) { onBack() }; return }
    var web by remember { mutableStateOf<WebView?>(null) }
    BackHandler { val w = web; if (w != null && w.canGoBack()) w.goBack() else onBack() }
    Column(Modifier.fillMaxSize()) {
        TopBar("HMIS", onBack) { TextButton(onClick = { web?.reload() }) { Text("Reload") } }
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.useWideViewPort = true
                    settings.loadWithOverviewMode = true
                    webViewClient = WebViewClient()
                    webChromeClient = WebChromeClient()
                    loadUrl(vm.prefs.serverUrl.trimEnd('/') + "/hmis#s=" + Uri.encode(session) + "&r=" + role + (if (start.isNotBlank()) "&go=$start" else ""))
                    web = this
                }
            },
        )
    }
}

/** A web page shown full screen over the app (used for the patient's messages). */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebDialog(url: String, title: String, onDismiss: () -> Unit) {
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(Ui.Bg)) {
            TopBar(title, onDismiss)
            AndroidView(modifier = Modifier.fillMaxSize(), factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true; settings.domStorageEnabled = true
                    webViewClient = WebViewClient(); webChromeClient = WebChromeClient()
                    loadUrl(url)
                }
            })
        }
    }
}
