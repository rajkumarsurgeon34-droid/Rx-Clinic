package com.shazverse.rxclinic

import android.Manifest
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.SideEffect
import androidx.core.view.WindowCompat
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import com.shazverse.rxclinic.call.CallScreen
import com.shazverse.rxclinic.call.CallState
import com.shazverse.rxclinic.call.CallViewModel
import com.shazverse.rxclinic.call.Palette
import com.shazverse.rxclinic.call.RxTheme
import com.shazverse.rxclinic.ui.RxApp
import com.shazverse.rxclinic.ui.RxLightTheme
import com.shazverse.rxclinic.ui.Ui

class MainActivity : ComponentActivity() {

    private val vm: CallViewModel by viewModels()
    private var afterPermissions: (() -> Unit)? = null

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            applyMediaChoices(result)
            val action = afterPermissions
            afterPermissions = null
            action?.invoke()
        }

    private val screenShareLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val data = result.data
            if (result.resultCode == RESULT_OK && data != null) vm.startScreenShare(data)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val inCall = vm.state != CallState.Idle
            SideEffect {
                // Dark status-bar icons on the light app; light icons on the dark video call.
                WindowCompat.getInsetsController(window, window.decorView).apply {
                    isAppearanceLightStatusBars = !inCall
                    isAppearanceLightNavigationBars = !inCall
                }
            }
            if (!inCall) {
                RxLightTheme {
                    Surface(color = Ui.Bg, contentColor = Ui.Text, modifier = Modifier.fillMaxSize()) {
                        RxApp(vm, withMedia = ::withMedia)
                    }
                }
            } else {
                RxTheme {
                    Surface(color = Palette.Bg, contentColor = Palette.Text, modifier = Modifier.fillMaxSize()) {
                        CallScreen(vm, requestScreenShare = ::requestScreenShare)
                    }
                }
            }
        }
    }

    /** Asks for camera, microphone and notification permission, then runs [action]. */
    private fun withMedia(action: () -> Unit) {
        val wanted = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            add(Manifest.permission.CAMERA)
            if (Build.VERSION.SDK_INT >= 31) add(Manifest.permission.BLUETOOTH_CONNECT)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = wanted.filter { !granted(it) }
        if (missing.isEmpty()) {
            applyMediaChoices(emptyMap())
            action()
        } else {
            afterPermissions = action
            permissionLauncher.launch(missing.toTypedArray())
        }
    }

    private fun applyMediaChoices(result: Map<String, Boolean>) {
        val mic = result[Manifest.permission.RECORD_AUDIO] ?: granted(Manifest.permission.RECORD_AUDIO)
        val cam = result[Manifest.permission.CAMERA] ?: granted(Manifest.permission.CAMERA)
        vm.micOn = mic && vm.prefs.startWithMic
        vm.camOn = cam && vm.prefs.startWithCamera
        if (!mic) Toast.makeText(this, "Microphone is off: permission not given", Toast.LENGTH_LONG).show()
    }

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun requestScreenShare() {
        val mpm = getSystemService(MediaProjectionManager::class.java) ?: return
        screenShareLauncher.launch(mpm.createScreenCaptureIntent())
    }
}
