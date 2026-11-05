package com.shazverse.rxclinic.call

import android.app.Application
import android.content.Intent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.shazverse.rxclinic.Api
import com.shazverse.rxclinic.Joined
import com.shazverse.rxclinic.Prefs
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import org.json.JSONObject

sealed interface CallState {
    data object Idle : CallState
    data object Connecting : CallState
    data object Waiting : CallState
    data object InCall : CallState
    data class Ended(val message: String) : CallState
}

data class ChatMessage(val from: String, val text: String, val mine: Boolean, val time: Long)
data class FloatingReaction(val id: Long, val emoji: String, val from: String)

/**
 * The SRK Meet call engine (LiveKit), built into Rx Clinic.
 * The doctor joins a teleconsult as host; the patient waits in the waiting room until admitted.
 */
class CallViewModel(app: Application) : AndroidViewModel(app) {

    private val appCtx: Application = app

    val prefs = Prefs(app)
    private val api get() = Api(prefs.serverUrl)

    var state by mutableStateOf<CallState>(CallState.Idle); private set
    var room by mutableStateOf<Room?>(null); private set
    /** Bumped on every room event so the UI re-reads participants. */
    var tick by mutableIntStateOf(0); private set
    /** The LiveKit room name of this teleconsult. */
    var code by mutableStateOf(""); private set
    var title by mutableStateOf(""); private set
    var role by mutableStateOf("guest"); private set
    var joinedAt by mutableLongStateOf(0L); private set

    var micOn by mutableStateOf(true)
    var camOn by mutableStateOf(true)
    var frontCamera by mutableStateOf(true); private set

    val chat = mutableStateListOf<ChatMessage>()
    var unreadChat by mutableIntStateOf(0); private set
    private var chatVisible = false
    val reactions = mutableStateListOf<FloatingReaction>()
    val notices = MutableSharedFlow<String>(extraBufferCapacity = 16)

    val isHost get() = role == "host"
    private var doctorSession: String? = null
    private var identity: String? = null
    private var myName: String = ""
    private var eventsJob: Job? = null
    private var rejoining = false
    private val raisedHands = mutableSetOf<String>()
    /** How to ask the server for a pass again (rejoin, or after being admitted). */
    private var fetchPass: (suspend (String?) -> Joined)? = null

    // ---------- Starting a teleconsult ----------

    /** Doctor starts or rejoins the video call for an appointment. */
    fun startAsDoctor(session: String, apptId: String, patientName: String, doctorName: String) {
        doctorSession = session
        myName = doctorName.ifBlank { "Doctor" }
        begin("Teleconsult · $patientName") { _ -> api.doctorToken(session, apptId) }
    }

    /** Patient joins with their booking code and mobile number. */
    fun startAsPatient(bookingCode: String, phone: String, patientName: String) {
        doctorSession = null
        myName = patientName.ifBlank { "Patient" }
        begin("Teleconsult with your doctor") { id -> api.patientToken(bookingCode, phone, id) }
    }

    private fun begin(callTitle: String, pass: suspend (String?) -> Joined) {
        fetchPass = pass
        title = callTitle
        identity = null
        chat.clear(); unreadChat = 0; reactions.clear(); raisedHands.clear()
        state = CallState.Connecting
        viewModelScope.launch {
            try {
                connectWith(pass(null))
            } catch (e: Exception) {
                cleanup()
                state = CallState.Ended(e.message ?: "Couldn't join the video call")
            }
        }
    }

    /** Used by the call screen's "Rejoin" button. */
    @Suppress("UNUSED_PARAMETER")
    fun join(meetingCode: String, meetingTitle: String = "") {
        val pass = fetchPass ?: return
        begin(title, pass)
    }

    private suspend fun connectWith(j: Joined) {
        val r = LiveKit.create(appCtx)
        room = r
        code = j.room
        if (j.title.isNotBlank()) title = j.title
        identity = j.identity
        role = j.role
        eventsJob?.cancel()
        eventsJob = viewModelScope.launch { r.events.collect { onEvent(r, it) } }
        r.connect(j.url, j.token)
        CallService.start(appCtx)
        if (j.role == "waiting") {
            state = CallState.Waiting
        } else {
            runCatching { r.localParticipant.setMicrophoneEnabled(micOn) }
            runCatching { r.localParticipant.setCameraEnabled(camOn) }
            if (joinedAt == 0L) joinedAt = System.currentTimeMillis()
            state = CallState.InCall
        }
        tick++
    }

    private fun rejoinAsGuest() {
        if (rejoining) return
        val pass = fetchPass ?: return
        rejoining = true
        viewModelScope.launch {
            try {
                // Ask for the full pass first, while the server can still see we were admitted.
                val joined = pass(identity)
                val old = room
                eventsJob?.cancel()
                old?.disconnect()
                old?.release()
                room = null
                state = CallState.Connecting
                connectWith(joined)
                notices.tryEmit("You're in. The doctor has let you join.")
            } catch (e: Exception) {
                leave("Couldn't join after being admitted: ${e.message}")
            } finally {
                rejoining = false
            }
        }
    }

    // ---------- Room events ----------

    private fun onEvent(r: Room, event: RoomEvent) {
        if (r !== room) return
        when (event) {
            is RoomEvent.DataReceived -> handleData(event.data, event.participant, event.topic)
            is RoomEvent.ParticipantConnected -> {
                val p = event.participant
                when {
                    p.isWaiting() && isHost -> notices.tryEmit("${p.displayName()} is waiting. Open People to admit.")
                    !p.isWaiting() && state == CallState.InCall -> notices.tryEmit("${p.displayName()} joined")
                }
            }
            is RoomEvent.ParticipantDisconnected -> {
                val p = event.participant
                raisedHands.remove(p.identityValue())
                if (!p.isWaiting() && state == CallState.InCall) notices.tryEmit("${p.displayName()} left")
            }
            is RoomEvent.ParticipantMetadataChanged -> {
                val p = event.participant
                if (p is LocalParticipant && state == CallState.Waiting && p.role() == "guest") rejoinAsGuest()
            }
            is RoomEvent.ParticipantAttributesChanged -> {
                val p = event.participant
                val id = p.identityValue()
                if (p.handRaised()) {
                    if (raisedHands.add(id) && p !is LocalParticipant) notices.tryEmit("✋ ${p.displayName()} raised their hand")
                } else {
                    raisedHands.remove(id)
                }
            }
            is RoomEvent.Disconnected -> {
                if (!rejoining) {
                    val msg = if (state == CallState.Waiting) "The doctor didn't let you in, or the consultation ended."
                    else "The consultation has ended."
                    leave(msg)
                }
            }
            else -> Unit
        }
        tick++
    }

    private fun handleData(data: ByteArray, from: RemoteParticipant?, topic: String?) {
        val o = runCatching { JSONObject(String(data, Charsets.UTF_8)) }.getOrNull() ?: return
        val name = from?.displayName() ?: o.optString("name", "Someone")
        when (topic) {
            "chat" -> {
                val text = o.optString("text").take(2000)
                if (text.isBlank()) return
                chat.add(ChatMessage(name, text, false, System.currentTimeMillis()))
                if (!chatVisible) unreadChat++
            }
            "reaction" -> showReaction(o.optString("emoji").take(8), name)
        }
    }

    private fun showReaction(emoji: String, from: String) {
        if (emoji.isBlank()) return
        val r = FloatingReaction(System.nanoTime(), emoji, from)
        reactions.add(r)
        viewModelScope.launch { delay(3500); reactions.remove(r) }
    }

    // ---------- Your own controls ----------

    fun toggleMic() = withRoom { r ->
        val on = !r.localParticipant.isMicrophoneEnabled
        if (r.localParticipant.setMicrophoneEnabled(on)) micOn = on
    }

    fun toggleCamera() = withRoom { r ->
        val on = !r.localParticipant.isCameraEnabled
        if (r.localParticipant.setCameraEnabled(on)) camOn = on
    }

    fun switchCamera() = withRoom { r ->
        val track = r.localParticipant.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack
            ?: return@withRoom
        frontCamera = !frontCamera
        track.switchCamera(position = if (frontCamera) CameraPosition.FRONT else CameraPosition.BACK)
    }

    fun startScreenShare(permissionData: Intent) = withRoom { r ->
        val ok = r.localParticipant.setScreenShareEnabled(
            true, ScreenCaptureParams(permissionData, onStop = { tick++ })
        )
        if (!ok) notices.tryEmit("Screen sharing couldn't start")
    }

    fun stopScreenShare() = withRoom { r -> r.localParticipant.setScreenShareEnabled(false) }

    fun toggleHand() = withRoom { r ->
        val up = !r.localParticipant.handRaised()
        r.localParticipant.updateAttributes(mapOf("hand" to if (up) "1" else "0"))
    }

    fun sendChat(text: String) = withRoom { r ->
        val clean = text.trim()
        if (clean.isEmpty()) return@withRoom
        val payload = JSONObject().put("text", clean).put("name", myName).toString().toByteArray()
        r.localParticipant.publishData(payload, topic = "chat")
            .onSuccess { chat.add(ChatMessage("You", clean, true, System.currentTimeMillis())) }
            .onFailure { notices.tryEmit("Message not sent") }
    }

    fun sendReaction(emoji: String) = withRoom { r ->
        val payload = JSONObject().put("emoji", emoji).put("name", myName).toString().toByteArray()
        r.localParticipant.publishData(payload, topic = "reaction")
        showReaction(emoji, "You")
    }

    fun setChatOpen(open: Boolean) {
        chatVisible = open
        if (open) unreadChat = 0
    }

    // ---------- Doctor (host) controls ----------

    fun admit(p: Participant) = hostCall { api.meet("admit", it, code, p.identityValue()) }

    fun admitAll() = hostCall { s ->
        room?.remoteParticipants?.values?.filter { it.isWaiting() }?.forEach { api.meet("admit", s, code, it.identityValue()) }
    }

    fun deny(p: Participant) = hostCall { api.meet("remove", it, code, p.identityValue()) }

    fun remove(p: Participant) = hostCall {
        api.meet("remove", it, code, p.identityValue())
        notices.tryEmit("${p.displayName()} was removed")
    }

    fun mute(p: Participant) = hostCall { api.meet("mute", it, code, p.identityValue()) }

    fun muteAll() = hostCall { s ->
        room?.remoteParticipants?.values
            ?.filter { !it.isWaiting() && it.isMicrophoneEnabled }
            ?.forEach { api.meet("mute", s, code, it.identityValue()) }
        notices.tryEmit("Everyone else is muted")
    }

    fun endForAll() = hostCall {
        api.meet("end", it, code, null)
        leave("You ended the consultation.")
    }

    fun inviteText(): String =
        "Your Rx Clinic teleconsult is ready. Open the Rx Clinic app → Patient → My appointments → Join video call."

    // ---------- Leaving ----------

    fun leave(message: String? = null) {
        cleanup()
        state = if (message != null) CallState.Ended(message) else CallState.Idle
    }

    fun backToHome() {
        state = CallState.Idle
    }

    private fun cleanup() {
        eventsJob?.cancel()
        eventsJob = null
        room?.let { r -> runCatching { r.disconnect() }; runCatching { r.release() } }
        room = null
        joinedAt = 0L
        frontCamera = true
        CallService.stop(appCtx)
    }

    override fun onCleared() {
        cleanup()
        super.onCleared()
    }

    private fun withRoom(block: suspend (Room) -> Unit) {
        val r = room ?: return
        viewModelScope.launch {
            try { block(r) } catch (e: Exception) { notices.tryEmit(e.message ?: "Something went wrong") }
            tick++
        }
    }

    private fun hostCall(block: suspend (String) -> Unit) {
        val s = doctorSession ?: return
        viewModelScope.launch {
            try { block(s) } catch (e: Exception) { notices.tryEmit(e.message ?: "That didn't work") }
            tick++
        }
    }
}
