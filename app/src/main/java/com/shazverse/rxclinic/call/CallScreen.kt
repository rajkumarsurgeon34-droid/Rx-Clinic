package com.shazverse.rxclinic.call

import android.content.ClipData
import android.content.ClipboardManager
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.StopScreenShare
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.PanTool
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.PersonRemove
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.shazverse.rxclinic.call.CallState
import com.shazverse.rxclinic.call.CallViewModel
import com.shazverse.rxclinic.call.FloatingReaction
import com.shazverse.rxclinic.call.cameraTrack
import com.shazverse.rxclinic.call.displayName
import com.shazverse.rxclinic.call.handRaised
import com.shazverse.rxclinic.call.identityValue
import com.shazverse.rxclinic.call.initials
import com.shazverse.rxclinic.call.isWaiting
import com.shazverse.rxclinic.call.role
import com.shazverse.rxclinic.call.screenTrack
import io.livekit.android.room.Room
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.participant.Participant
import kotlinx.coroutines.delay

private enum class Sheet { None, Chat, People, More }

@Composable
fun CallScreen(vm: CallViewModel, requestScreenShare: () -> Unit) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { vm.notices.collect { snackbar.showSnackbar(it) } }

    val view = LocalView.current
    DisposableEffect(Unit) {
        view.keepScreenOn = true
        onDispose { view.keepScreenOn = false }
    }

    Box(Modifier.fillMaxSize().background(Palette.Bg)) {
        when (val s = vm.state) {
            CallState.Connecting -> CenterMessage {
                CircularProgressIndicator(color = Palette.Teal)
                Spacer(Modifier.height(16.dp))
                Text("Connecting the video call…", color = Palette.Muted)
            }
            CallState.Waiting -> WaitingRoom(vm)
            CallState.InCall -> InCall(vm, requestScreenShare)
            is CallState.Ended -> CenterMessage {
                BackHandler { vm.backToHome() }
                Text("👋", fontSize = 48.sp)
                Spacer(Modifier.height(12.dp))
                Text(s.message, textAlign = TextAlign.Center, fontSize = 17.sp)
                Spacer(Modifier.height(24.dp))
                Button(onClick = { vm.backToHome() }) { Text("Back to Rx Clinic") }
                if (!s.message.startsWith("You ended")) {
                    TextButton(onClick = { vm.join(vm.code, vm.title) }) { Text("Rejoin") }
                }
            }
            CallState.Idle -> Unit
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 56.dp))
    }
}

@Composable
private fun CenterMessage(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) { content() }
}

@Composable
private fun WaitingRoom(vm: CallViewModel) {
    BackHandler { vm.leave() }
    CenterMessage {
        CircularProgressIndicator(color = Palette.Teal)
        Spacer(Modifier.height(20.dp))
        Text("Please wait. The doctor will let you in shortly.", fontSize = 19.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text("Keep this screen open. Your camera and microphone are ready.", color = Palette.Muted, textAlign = TextAlign.Center)
        Spacer(Modifier.height(28.dp))
        OutlinedButton(onClick = { vm.leave() }) { Text("Leave") }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InCall(vm: CallViewModel, requestScreenShare: () -> Unit) {
    val room = vm.room ?: return
    @Suppress("UNUSED_VARIABLE") val tick = vm.tick // re-read participants on every room event
    val local = room.localParticipant
    val everyone: List<Participant> = listOf<Participant>(local) +
        room.remoteParticipants.values.filter { !it.isWaiting() }.sortedBy { it.displayName().lowercase() }
    val waiting = room.remoteParticipants.values.filter { it.isWaiting() }
    val sharer = everyone.firstOrNull { it.screenTrack() != null }

    var sheet by remember { mutableStateOf(Sheet.None) }
    var confirmLeave by remember { mutableStateOf(false) }
    BackHandler { confirmLeave = true }
    LaunchedEffect(sheet) { vm.setChatOpen(sheet == Sheet.Chat) }

    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        TopBar(vm, everyone.size, waiting.size) { sheet = Sheet.People }
        Box(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 8.dp)) {
            if (sharer != null) {
                ScreenShareStage(room, sharer, everyone)
            } else {
                ParticipantGrid(room, everyone)
            }
            ReactionsOverlay(vm.reactions)
        }
        ControlBar(
            micOn = local.isMicrophoneEnabled,
            camOn = local.isCameraEnabled,
            sharing = local.isScreenShareEnabled,
            unread = vm.unreadChat,
            hostAlerts = if (vm.isHost) waiting.size else 0,
            onMic = vm::toggleMic,
            onCam = vm::toggleCamera,
            onShare = { if (local.isScreenShareEnabled) vm.stopScreenShare() else requestScreenShare() },
            onChat = { sheet = Sheet.Chat },
            onMore = { sheet = Sheet.More },
            onLeave = { confirmLeave = true },
        )
    }

    if (sheet != Sheet.None) {
        ModalBottomSheet(
            onDismissRequest = { sheet = Sheet.None },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = sheet == Sheet.Chat),
            containerColor = Palette.Surface,
        ) {
            when (sheet) {
                Sheet.Chat -> ChatSheet(vm)
                Sheet.People -> PeopleSheet(vm, everyone, waiting)
                Sheet.More -> MoreSheet(vm, local, onPeople = { sheet = Sheet.People }, onDone = { sheet = Sheet.None })
                Sheet.None -> Unit
            }
        }
    }

    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text("Leave the consultation?") },
            text = { if (vm.isHost) Text("You can leave and let others continue, or end the consultation for everyone.") },
            confirmButton = {
                Button(
                    onClick = { confirmLeave = false; vm.leave() },
                    colors = ButtonDefaults.buttonColors(containerColor = Palette.Red),
                ) { Text("Leave") }
            },
            dismissButton = {
                Row {
                    if (vm.isHost) TextButton(onClick = { confirmLeave = false; vm.endForAll() }) { Text("End for all", color = Palette.Red) }
                    TextButton(onClick = { confirmLeave = false }) { Text("Stay") }
                }
            },
        )
    }
}

@Composable
private fun TopBar(vm: CallViewModel, count: Int, waitingCount: Int, onPeople: () -> Unit) {
    val context = LocalContext.current
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    val secs = ((now - vm.joinedAt) / 1000).coerceAtLeast(0)
    val timer = if (secs >= 3600) "%d:%02d:%02d".format(secs / 3600, secs / 60 % 60, secs % 60) else "%02d:%02d".format(secs / 60, secs % 60)

    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(vm.title.ifBlank { "Meeting" }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(timer, color = Palette.Muted, fontSize = 12.sp)
        }
                Box {
            TextButton(onClick = onPeople) {
                Icon(Icons.Filled.People, null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(4.dp))
                Text("$count")
            }
            if (vm.isHost && waitingCount > 0) Badge(waitingCount, Modifier.align(Alignment.TopEnd))
        }
    }
}

@Composable
private fun ParticipantGrid(room: Room, people: List<Participant>) {
    val n = people.size
    when {
        n == 1 -> Tile(room, people[0], Modifier.fillMaxSize().padding(4.dp))
        n == 2 -> Column(Modifier.fillMaxSize()) {
            people.forEach { p -> key(p.identityValue()) { Tile(room, p, Modifier.weight(1f).fillMaxWidth().padding(4.dp)) } }
        }
        n <= 6 -> {
            val rows = people.chunked(2)
            Column(Modifier.fillMaxSize()) {
                rows.forEach { row ->
                    Row(Modifier.weight(1f).fillMaxWidth()) {
                        row.forEach { p -> key(p.identityValue()) { Tile(room, p, Modifier.weight(1f).fillMaxHeight().padding(4.dp)) } }
                        if (row.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
        else -> LazyVerticalGrid(GridCells.Fixed(2), Modifier.fillMaxSize()) {
            items(people, key = { it.identityValue() }) { p ->
                Tile(room, p, Modifier.aspectRatio(0.8f).padding(4.dp))
            }
        }
    }
}

@Composable
private fun ScreenShareStage(room: Room, sharer: Participant, people: List<Participant>) {
    Column(Modifier.fillMaxSize()) {
        Box(
            Modifier.weight(1f).fillMaxWidth().padding(4.dp).clip(RoundedCornerShape(16.dp)).background(Color.Black),
        ) {
            val track = sharer.screenTrack()
            if (track != null && sharer !is LocalParticipant) {
                VideoView(room, track, Modifier.fillMaxSize(), fill = false)
            } else {
                Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.AutoMirrored.Filled.ScreenShare, null, tint = Palette.Teal, modifier = Modifier.size(40.dp))
                    Spacer(Modifier.height(8.dp))
                    Text("You're sharing your screen", color = Palette.Muted)
                }
            }
            NameChip("${sharer.displayName()}'s screen", null, Modifier.align(Alignment.BottomStart).padding(8.dp))
        }
        LazyRow(Modifier.height(130.dp).fillMaxWidth(), contentPadding = PaddingValues(horizontal = 0.dp)) {
            items(people, key = { it.identityValue() }) { p ->
                Tile(room, p, Modifier.width(104.dp).fillMaxHeight().padding(4.dp), compact = true)
            }
        }
    }
}

@Composable
private fun Tile(room: Room, p: Participant, modifier: Modifier, compact: Boolean = false) {
    val isLocal = p is LocalParticipant
    val name = p.displayName() + if (isLocal) " (You)" else ""
    val video = p.cameraTrack()
    Box(
        modifier.clip(RoundedCornerShape(16.dp)).background(Palette.Card)
            .then(if (p.isSpeaking) Modifier.border(2.dp, Palette.Teal, RoundedCornerShape(16.dp)) else Modifier),
    ) {
        if (video != null) {
            VideoView(room, video, Modifier.fillMaxSize(), mirror = isLocal)
        } else {
            Avatar(p.displayName(), if (compact) 44.dp else 84.dp, Modifier.align(Alignment.Center))
        }
        if (p.handRaised()) {
            Box(
                Modifier.align(Alignment.TopEnd).padding(8.dp).size(30.dp).background(Palette.Amber, CircleShape),
                contentAlignment = Alignment.Center,
            ) { Text("✋", fontSize = 15.sp) }
        }
        NameChip(
            if (compact) p.displayName().substringBefore(' ') else name,
            if (!p.isMicrophoneEnabled) Icons.Filled.MicOff else null,
            Modifier.align(Alignment.BottomStart).padding(6.dp),
            host = !compact && p.role() == "host",
        )
    }
}

@Composable
private fun NameChip(text: String, icon: ImageVector?, modifier: Modifier, host: Boolean = false) {
    Row(
        modifier.background(Color.Black.copy(alpha = 0.55f), RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = Palette.Red, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
        }
        Text(text, fontSize = 12.sp, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (host) {
            Spacer(Modifier.width(6.dp))
            Text("HOST", fontSize = 9.sp, color = Palette.Teal, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun Avatar(name: String, size: Dp, modifier: Modifier = Modifier) {
    val colors = listOf(Color(0xFF2563EB), Color(0xFF0D9488), Color(0xFF7C3AED), Color(0xFFDB2777), Color(0xFFEA580C), Color(0xFF16A34A))
    val c = colors[(name.hashCode() and 0x7fffffff) % colors.size]
    Box(modifier.size(size).background(c, CircleShape), contentAlignment = Alignment.Center) {
        Text(initials(name), color = Color.White, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.36f).sp)
    }
}

@Composable
private fun Badge(count: Int, modifier: Modifier) {
    Box(modifier.size(18.dp).background(Palette.Red, CircleShape), contentAlignment = Alignment.Center) {
        Text(if (count > 9) "9+" else "$count", color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun ControlBar(
    micOn: Boolean, camOn: Boolean, sharing: Boolean, unread: Int, hostAlerts: Int,
    onMic: () -> Unit, onCam: () -> Unit, onShare: () -> Unit, onChat: () -> Unit, onMore: () -> Unit, onLeave: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.SpaceEvenly,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RoundControl(if (micOn) Icons.Filled.Mic else Icons.Filled.MicOff, if (micOn) "Mute" else "Unmute", active = micOn, onClick = onMic)
        RoundControl(if (camOn) Icons.Filled.Videocam else Icons.Filled.VideocamOff, if (camOn) "Stop video" else "Start video", active = camOn, onClick = onCam)
        RoundControl(
            if (sharing) Icons.AutoMirrored.Filled.StopScreenShare else Icons.AutoMirrored.Filled.ScreenShare, if (sharing) "Stop sharing" else "Share screen",
            active = true, highlight = sharing, onClick = onShare,
        )
        Box {
            RoundControl(Icons.AutoMirrored.Filled.Chat, "Chat", active = true, onClick = onChat)
            if (unread > 0) Badge(unread, Modifier.align(Alignment.TopEnd))
        }
        Box {
            RoundControl(Icons.Filled.MoreHoriz, "More", active = true, onClick = onMore)
            if (hostAlerts > 0) Badge(hostAlerts, Modifier.align(Alignment.TopEnd))
        }
        RoundControl(Icons.Filled.CallEnd, "Leave", active = true, danger = true, onClick = onLeave)
    }
}

@Composable
private fun RoundControl(
    icon: ImageVector, label: String, active: Boolean, onClick: () -> Unit,
    danger: Boolean = false, highlight: Boolean = false,
) {
    val bg = when {
        danger -> Palette.Red
        highlight -> Palette.Teal
        !active -> Color(0xFF3F1D24)
        else -> Palette.CardHigh
    }
    val tint = when {
        highlight -> Color(0xFF042F2E)
        !active -> Palette.Red
        else -> Color.White
    }
    Box(
        Modifier.size(50.dp).clip(CircleShape).background(bg).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, label, tint = tint) }
}

@Composable
private fun BoxScope.ReactionsOverlay(reactions: List<FloatingReaction>) {
    Column(Modifier.align(Alignment.BottomStart).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        reactions.takeLast(6).forEach { r -> key(r.id) { ReactionBubble(r) } }
    }
}

@Composable
private fun ReactionBubble(r: FloatingReaction) {
    val rise = remember { Animatable(0f) }
    LaunchedEffect(r.id) { rise.animateTo(1f, tween(3400, easing = LinearEasing)) }
    Row(
        Modifier
            .graphicsLayer { translationY = -rise.value * 120f }
            .alpha(if (rise.value > 0.75f) (1f - rise.value) * 4f else 1f)
            .background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(20.dp))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(r.emoji, fontSize = 26.sp)
        Spacer(Modifier.width(6.dp))
        Text(r.from, fontSize = 12.sp, color = Color.White)
    }
}

// ---------- Sheets ----------

@Composable
private fun ChatSheet(vm: CallViewModel) {
    var draft by remember { mutableStateOf("") }
    val listState = rememberLazyListState()
    LaunchedEffect(vm.chat.size) { if (vm.chat.isNotEmpty()) listState.animateScrollToItem(vm.chat.size - 1) }
    Column(Modifier.fillMaxWidth().fillMaxHeight(0.85f).imePadding().padding(horizontal = 16.dp)) {
        Text("Chat", fontWeight = FontWeight.Bold, fontSize = 18.sp)
        Text("Messages are seen by everyone in this consultation", color = Palette.Muted, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (vm.chat.isEmpty()) item { Text("No messages yet. Say hi! 👋", color = Palette.Muted, modifier = Modifier.padding(vertical = 24.dp)) }
            items(vm.chat) { m ->
                Column(Modifier.fillMaxWidth(), horizontalAlignment = if (m.mine) Alignment.End else Alignment.Start) {
                    if (!m.mine) Text(m.from, color = Palette.Teal, fontSize = 12.sp)
                    Text(
                        m.text,
                        Modifier.background(if (m.mine) Palette.Blue else Palette.Card, RoundedCornerShape(14.dp)).padding(horizontal = 12.dp, vertical = 8.dp),
                        color = Color.White,
                    )
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(draft, { draft = it.take(2000) }, Modifier.weight(1f), placeholder = { Text("Message") }, maxLines = 4)
            IconButton(onClick = { vm.sendChat(draft); draft = "" }, enabled = draft.isNotBlank()) {
                Icon(Icons.AutoMirrored.Filled.Send, "Send", tint = if (draft.isNotBlank()) Palette.Teal else Palette.Muted)
            }
        }
    }
}

@Composable
private fun PeopleSheet(vm: CallViewModel, people: List<Participant>, waiting: List<Participant>) {
    LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
        if (vm.isHost && waiting.isNotEmpty()) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Waiting room (${waiting.size})", fontWeight = FontWeight.Bold, fontSize = 17.sp, modifier = Modifier.weight(1f))
                    TextButton(onClick = vm::admitAll) { Text("Admit all") }
                }
            }
            items(waiting, key = { "w" + it.identityValue() }) { p ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(p.displayName(), 36.dp)
                    Spacer(Modifier.width(12.dp))
                    Text(p.displayName(), Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    TextButton(onClick = { vm.deny(p) }) { Text("Deny", color = Palette.Red) }
                    Button(onClick = { vm.admit(p) }) { Text("Admit") }
                }
            }
            item { HorizontalDivider(Modifier.padding(vertical = 10.dp)) }
        }
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("In the consultation (${people.size})", fontWeight = FontWeight.Bold, fontSize = 17.sp, modifier = Modifier.weight(1f))
                if (vm.isHost && people.size > 1) TextButton(onClick = vm::muteAll) { Text("Mute all") }
            }
        }
        items(people, key = { it.identityValue() }) { p ->
            val isLocal = p is LocalParticipant
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(p.displayName(), 36.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(p.displayName() + if (isLocal) " (You)" else "", maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (p.role() == "host") Text("Host", color = Palette.Teal, fontSize = 12.sp)
                }
                if (p.handRaised()) Text("✋", fontSize = 18.sp, modifier = Modifier.padding(horizontal = 4.dp))
                Icon(
                    if (p.isMicrophoneEnabled) Icons.Filled.Mic else Icons.Filled.MicOff, null,
                    tint = if (p.isMicrophoneEnabled) Palette.Muted else Palette.Red, modifier = Modifier.size(20.dp),
                )
                if (vm.isHost && !isLocal) {
                    IconButton(onClick = { vm.mute(p) }, enabled = p.isMicrophoneEnabled) { Icon(Icons.AutoMirrored.Filled.VolumeOff, "Mute ${p.displayName()}") }
                    IconButton(onClick = { vm.remove(p) }) { Icon(Icons.Filled.PersonRemove, "Remove ${p.displayName()}", tint = Palette.Red) }
                }
            }
        }
        if (!vm.isHost) {
            item {
                Text("Only the doctor can admit, mute or remove people.", color = Palette.Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 12.dp))
            }
        }
    }
}

@Composable
private fun MoreSheet(vm: CallViewModel, local: LocalParticipant, onPeople: () -> Unit, onDone: () -> Unit) {
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
        Text("Reactions", color = Palette.Muted, fontSize = 13.sp)
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            listOf("👍", "❤️", "😂", "👏", "🎉", "😮").forEach { e ->
                Box(
                    Modifier.size(48.dp).clip(CircleShape).background(Palette.Card).clickable { vm.sendReaction(e); onDone() },
                    contentAlignment = Alignment.Center,
                ) { Text(e, fontSize = 24.sp) }
            }
        }
        HorizontalDivider(Modifier.padding(vertical = 8.dp))
        MenuRow(Icons.Filled.PanTool, if (local.handRaised()) "Lower hand" else "Raise hand") { vm.toggleHand(); onDone() }
        MenuRow(Icons.Filled.Cameraswitch, "Switch camera", enabled = local.isCameraEnabled) { vm.switchCamera(); onDone() }
        MenuRow(Icons.Filled.People, "Participants") { onPeople() }
        if (vm.isHost) {
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Text("Doctor controls", color = Palette.Muted, fontSize = 13.sp)
            MenuRow(Icons.Filled.MicOff, "Mute everyone") { vm.muteAll(); onDone() }
            MenuRow(Icons.Filled.CallEnd, "End consultation", danger = true) { vm.endForAll() }
        }
    }
}

@Composable
private fun MenuRow(icon: ImageVector, text: String, enabled: Boolean = true, danger: Boolean = false, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 14.dp, horizontal = 8.dp).alpha(if (enabled) 1f else 0.4f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = if (danger) Palette.Red else Palette.Text)
        Spacer(Modifier.width(16.dp))
        Text(text, color = if (danger) Palette.Red else Palette.Text, fontSize = 16.sp)
    }
}
