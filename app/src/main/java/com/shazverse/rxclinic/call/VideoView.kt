package com.shazverse.rxclinic.call

import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import livekit.org.webrtc.RendererCommon

/** Shows one LiveKit video track. `fill` crops to fill the tile; screen shares use fit. */
@Composable
fun VideoView(
    room: Room,
    track: VideoTrack,
    modifier: Modifier = Modifier,
    mirror: Boolean = false,
    fill: Boolean = true,
) {
    key(track) {
        AndroidView(
            factory = { ctx ->
                TextureViewRenderer(ctx).apply {
                    room.initVideoRenderer(this)
                    setMirror(mirror)
                    setScalingType(
                        if (fill) RendererCommon.ScalingType.SCALE_ASPECT_FILL
                        else RendererCommon.ScalingType.SCALE_ASPECT_FIT
                    )
                    track.addRenderer(this)
                }
            },
            update = { it.setMirror(mirror) },
            onRelease = { view ->
                track.removeRenderer(view)
                view.release()
            },
            modifier = modifier,
        )
    }
}
