package com.shazverse.rxclinic.call

import io.livekit.android.room.participant.Participant
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import org.json.JSONObject

/** Role is set by the server in the token: host, guest or waiting. */
fun Participant.role(): String =
    runCatching { JSONObject(metadata ?: "{}").optString("role", "guest") }.getOrDefault("guest")

fun Participant.isWaiting() = role() == "waiting"

fun Participant.displayName(): String =
    name?.takeIf { it.isNotBlank() } ?: identity?.value ?: "Guest"

fun Participant.identityValue(): String = identity?.value ?: ""

fun Participant.handRaised(): Boolean = attributes["hand"] == "1"

fun Participant.cameraTrack(): VideoTrack? {
    val pub = getTrackPublication(Track.Source.CAMERA) ?: return null
    if (pub.muted) return null
    return pub.track as? VideoTrack
}

fun Participant.screenTrack(): VideoTrack? {
    val pub = getTrackPublication(Track.Source.SCREEN_SHARE) ?: return null
    if (pub.muted) return null
    return pub.track as? VideoTrack
}

fun initials(name: String): String =
    name.split(' ', '-', '_').filter { it.isNotBlank() }.take(2)
        .joinToString("") { it.first().uppercase() }.ifBlank { "?" }
