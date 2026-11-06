package com.shazverse.rxclinic.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.shazverse.rxclinic.call.CallViewModel

/**
 * Script added to every HMIS page inside the app: printing goes to Android's print screen,
 * WhatsApp/UPI links open the right app, and an "App tools" button sits beside Sign out.
 */
private const val BRIDGE_JS = """(function(){if(window.__rxApp)return;window.__rxApp=1;
window.print=function(){RxApp.printPage(document.title||'Rx Clinic')};
window.open=function(u){if(u){RxApp.openLink(String(u));return null}var buf='';
 return{document:{write:function(h){buf+=h},close:function(){}},focus:function(){},close:function(){},print:function(){RxApp.printHtml(buf)}}};
var o=document.getElementById('out');
if(o&&!document.getElementById('apptools')){var b=document.createElement('button');b.id='apptools';b.className=o.className;b.textContent='App tools';
 b.style.cssText=o.getAttribute('style')||'';b.style.marginRight='6px';b.onclick=function(){RxApp.tools()};o.parentNode.insertBefore(b,o)}
})();"""

/**
 * The HMIS (BackBone-style dashboard, patient chart, pharmacy, lab, accounts and the rest),
 * the main workspace for every staff login. Video calls, admin settings and the older screens
 * open from "App tools".
 */
@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
@Composable
fun HmisWebScreen(vm: CallViewModel, start: String = "", onTools: () -> Unit, onSignedOut: () -> Unit, onBack: () -> Unit) {
    val role = vm.prefs.staffRole
    val session = role?.let { vm.prefs.session(it) } ?: run { LaunchedEffect(Unit) { onSignedOut() }; return }
    val server = vm.prefs.serverUrl.trimEnd('/')
    val host = remember(server) { Uri.parse(server).host }
    var web by remember { mutableStateOf<WebView?>(null) }
    var pending by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val toolsCb by rememberUpdatedState(onTools)
    val signedOut by rememberUpdatedState(onSignedOut)
    val main = remember { Handler(Looper.getMainLooper()) }

    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        pending?.onReceiveValue(if (uri != null) arrayOf(uri) else null); pending = null
    }

    fun signOut() { vm.prefs.staffRole?.let { vm.prefs.saveSession(it, null) }; signedOut() }

    BackHandler {
        val w = web
        if (w != null && w.canGoBack()) w.goBack() else onBack()
    }
    Column(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color(0xFF0F5F6B))) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.useWideViewPort = true
                    settings.loadWithOverviewMode = true
                    addJavascriptInterface(object {
                        @JavascriptInterface fun printPage(title: String) { main.post { web?.let { w ->
                            val pm = ctx.getSystemService(android.content.Context.PRINT_SERVICE) as android.print.PrintManager
                            pm.print(title, w.createPrintDocumentAdapter(title), android.print.PrintAttributes.Builder().setMediaSize(android.print.PrintAttributes.MediaSize.ISO_A4).build())
                        } } }
                        @JavascriptInterface fun printHtml(html: String) { main.post { Printer.print(ctx, "Rx Clinic", html) } }
                        @JavascriptInterface fun openLink(url: String) { main.post { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } } }
                        @JavascriptInterface fun tools() { main.post { toolsCb() } }
                    }, "RxApp")
                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                            val u = request.url
                            if (u.host == host && u.path == "/login") { signOut(); return true }
                            if ((u.scheme == "http" || u.scheme == "https") && u.host == host) return false
                            runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                            return true
                        }
                        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                            val u = url?.let { Uri.parse(it) }
                            if (u != null && u.host == host && u.path == "/login") { view.stopLoading(); signOut() }
                        }
                        override fun onPageFinished(view: WebView, url: String?) { view.evaluateJavascript(BRIDGE_JS, null) }
                    }
                    webChromeClient = object : WebChromeClient() {
                        override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                            pending?.onReceiveValue(null); pending = cb
                            runCatching { pick.launch(arrayOf("image/*", "application/pdf")) }.onFailure { pending?.onReceiveValue(null); pending = null }
                            return true
                        }
                    }
                    loadUrl("$server/hmis#s=" + Uri.encode(session) + "&r=" + role + (if (start.isNotBlank()) "&go=$start" else ""))
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
