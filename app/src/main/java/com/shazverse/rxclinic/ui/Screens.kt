@file:OptIn(ExperimentalMaterial3Api::class)

package com.shazverse.rxclinic.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Biotech
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.EventAvailable
import androidx.compose.material.icons.filled.LocalHospital
import androidx.compose.material.icons.filled.LocalPharmacy
import androidx.compose.material.icons.filled.MedicalServices
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.shazverse.rxclinic.Api
import com.shazverse.rxclinic.Appt
import com.shazverse.rxclinic.MyBooking
import com.shazverse.rxclinic.Slot
import com.shazverse.rxclinic.call.CallViewModel
import com.shazverse.rxclinic.call.Palette
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale

private enum class Screen { Home, PatientHome, Book, MyAppointments, DoctorLogin, DoctorDay }

/** Everything outside the video call. */
@Composable
fun RxApp(vm: CallViewModel, withMedia: (() -> Unit) -> Unit) {
    var screen by rememberSaveable { mutableStateOf(Screen.Home) }
    var showSettings by remember { mutableStateOf(false) }
    var comingSoon by remember { mutableStateOf<String?>(null) }
    val prefs = vm.prefs

    Box(Modifier.fillMaxSize().background(Palette.Bg).statusBarsPadding().navigationBarsPadding()) {
        when (screen) {
            Screen.Home -> HomeScreen(
                onPatient = { screen = Screen.PatientHome },
                onDoctor = { screen = if (prefs.session("doctor") != null) Screen.DoctorDay else Screen.DoctorLogin },
                onOther = { comingSoon = it },
                onSettings = { showSettings = true },
            )
            Screen.PatientHome -> PatientHome(
                onBack = { screen = Screen.Home },
                onBook = { screen = Screen.Book },
                onMine = { screen = Screen.MyAppointments },
            )
            Screen.Book -> BookScreen(vm, onBack = { screen = Screen.PatientHome }, onDone = { screen = Screen.MyAppointments })
            Screen.MyAppointments -> MyAppointments(vm, withMedia, onBack = { screen = Screen.PatientHome }, onBook = { screen = Screen.Book })
            Screen.DoctorLogin -> DoctorLogin(vm, onBack = { screen = Screen.Home }, onIn = { screen = Screen.DoctorDay })
            Screen.DoctorDay -> DoctorDay(vm, withMedia, onBack = { screen = Screen.Home }, onSignedOut = { screen = Screen.DoctorLogin })
        }
    }

    if (showSettings) SettingsDialog(vm, onDismiss = { showSettings = false })
    comingSoon?.let { who ->
        AlertDialog(
            onDismissRequest = { comingSoon = null },
            title = { Text(who) },
            text = { Text("The $who section moves into the app in the next update: same screens as the Rx Clinic preview, with its own PIN.") },
            confirmButton = { TextButton(onClick = { comingSoon = null }) { Text("OK") } },
        )
    }
}

// ---------------- Shared pieces ----------------

@Composable
private fun TopBar(title: String, onBack: (() -> Unit)?, actions: @Composable () -> Unit = {}) {
    if (onBack != null) BackHandler { onBack() }
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
        else Spacer(Modifier.width(12.dp))
        Text(title, fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        actions()
    }
}

@Composable
private fun Card(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(
        modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Palette.Card).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) { content() }
}

@Composable
private fun Pill(text: String, color: Color) {
    Text(
        text, color = color, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(color.copy(alpha = 0.15f)).padding(horizontal = 10.dp, vertical = 3.dp),
    )
}

@Composable
private fun Choice(text: String, selected: Boolean, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val bg = if (selected) Palette.Blue else Palette.CardHigh
    Text(
        text,
        color = when { selected -> Color.White; enabled -> Palette.Text; else -> Palette.Muted.copy(alpha = 0.4f) },
        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        modifier = modifier.clip(RoundedCornerShape(12.dp)).background(if (enabled) bg else Palette.Card)
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp),
    )
}

@Composable
private fun ErrorText(msg: String?) {
    if (!msg.isNullOrBlank()) Text(msg, color = Palette.Red, fontSize = 14.sp)
}

fun statusLabel(s: String) = when (s) {
    "booked" -> "Booked"; "arrived" -> "Arrived"; "in-call" -> "In teleconsult"; "completed" -> "Completed"
    "cancelled" -> "Cancelled"; "no-show" -> "No-show"; else -> s
}

fun statusColor(s: String) = when (s) {
    "completed" -> Color(0xFF74D19F); "cancelled", "no-show" -> Palette.Muted; "in-call", "arrived" -> Palette.Teal; else -> Palette.Amber
}

private val DAY_FMT = DateTimeFormatter.ofPattern("EEE d MMM", Locale.ENGLISH)
fun dayLabel(iso: String): String {
    val d = runCatching { LocalDate.parse(iso) }.getOrNull() ?: return iso
    val today = LocalDate.now()
    return when (d) { today -> "Today"; today.plusDays(1) -> "Tomorrow"; today.minusDays(1) -> "Yesterday"; else -> d.format(DAY_FMT) }
}

fun time12(t: String): String = runCatching {
    LocalTime.parse(t).format(DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)).lowercase()
}.getOrDefault(t)

// ---------------- Home ----------------

@Composable
private fun HomeScreen(onPatient: () -> Unit, onDoctor: () -> Unit, onOther: (String) -> Unit, onSettings: () -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("℞", color = Palette.Red, fontSize = 34.sp, fontFamily = FontFamily.Serif)
            Spacer(Modifier.width(8.dp))
            Text("Rx Clinic", fontSize = 26.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Serif, modifier = Modifier.weight(1f))
            IconButton(onClick = onSettings) { Icon(Icons.Filled.Settings, "Settings") }
        }
        Text("Who is using the app?", color = Palette.Muted, modifier = Modifier.padding(bottom = 16.dp))
        RoleCard("Patient", "Book an appointment, join your video teleconsult", Icons.Filled.Person, onPatient)
        RoleCard("Doctor", "Appointments and video teleconsults", Icons.Filled.MedicalServices, onDoctor)
        RoleCard("Nursing staff", "Ward vitals, medicines given, nursing notes", Icons.Filled.LocalHospital) { onOther("Nursing staff") }
        RoleCard("Pharmacy", "Prescriptions to dispense, stock", Icons.Filled.LocalPharmacy) { onOther("Pharmacy") }
        RoleCard("Lab & diagnostics", "Orders, samples, reports", Icons.Filled.Biotech) { onOther("Lab & diagnostics") }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun RoleCard(title: String, sub: String, icon: ImageVector, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(bottom = 10.dp).clip(RoundedCornerShape(16.dp)).background(Palette.Card).clickable(onClick = onClick).padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(44.dp).clip(CircleShape).background(Palette.Blue.copy(alpha = 0.25f)), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = Palette.Teal)
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
            Text(sub, color = Palette.Muted, fontSize = 13.sp)
        }
    }
}

@Composable
private fun SettingsDialog(vm: CallViewModel, onDismiss: () -> Unit) {
    var server by remember { mutableStateOf(vm.prefs.serverUrl) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Settings") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(server, { server = it }, label = { Text("Rx Clinic server address") }, singleLine = true)
                Text("Set once. It's the address of your Rx Clinic Cloudflare Worker.", color = Palette.Muted, fontSize = 13.sp)
            }
        },
        confirmButton = { Button(onClick = { vm.prefs.serverUrl = server; onDismiss() }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// ---------------- Patient ----------------

@Composable
private fun PatientHome(onBack: () -> Unit, onBook: () -> Unit, onMine: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        TopBar("Patient", onBack)
        Column(Modifier.padding(horizontal = 16.dp)) {
            RoleCard("Book an appointment", "Visit the clinic or see the doctor on video", Icons.Filled.CalendarMonth, onBook)
            RoleCard("My appointments", "Check your booking and join your video teleconsult", Icons.Filled.EventAvailable, onMine)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BookScreen(vm: CallViewModel, onBack: () -> Unit, onDone: () -> Unit) {
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    var mode by rememberSaveable { mutableStateOf("clinic") }
    var date by rememberSaveable { mutableStateOf(LocalDate.now().toString()) }
    var time by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var age by rememberSaveable { mutableStateOf("") }
    var sex by rememberSaveable { mutableStateOf("") }
    var phone by rememberSaveable { mutableStateOf("") }
    var reason by rememberSaveable { mutableStateOf("") }
    var lang by rememberSaveable { mutableStateOf("en") }
    var consent by rememberSaveable { mutableStateOf(false) }
    var slots by remember { mutableStateOf<List<Slot>?>(null) }
    var slotErr by remember { mutableStateOf<String?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var booked by remember { mutableStateOf<Appt?>(null) }

    LaunchedEffect(date) {
        slots = null; slotErr = null
        try { slots = api.slots(date) } catch (e: Exception) { slotErr = e.message }
    }

    booked?.let { a ->
        AlertDialog(
            onDismissRequest = {},
            title = { Text("Appointment booked") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("${dayLabel(a.date)}, ${time12(a.time)} · ${if (a.isTele) "Video teleconsult" else "Clinic visit"}")
                    Text("Your booking code", color = Palette.Muted, fontSize = 13.sp)
                    Text(a.code, fontSize = 32.sp, fontFamily = FontFamily.Monospace, color = Palette.Teal, fontWeight = FontWeight.Bold)
                    Text(
                        if (a.isTele) "At your time, open My appointments and tap Join video call." else "Show this code at the reception desk.",
                        color = Palette.Muted, fontSize = 13.sp,
                    )
                }
            },
            confirmButton = { Button(onClick = { booked = null; onDone() }) { Text("Done") } },
        )
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar("Book an appointment", onBack)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Choice("Visit the clinic", mode == "clinic", modifier = Modifier.weight(1f)) { mode = "clinic" }
                Choice("Video teleconsult", mode == "tele", modifier = Modifier.weight(1f)) { mode = "tele" }
            }
            Text("Day", color = Palette.Muted, fontSize = 13.sp)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                (0..6).forEach { i ->
                    val d = LocalDate.now().plusDays(i.toLong()).toString()
                    Choice(dayLabel(d), date == d) { date = d; time = "" }
                }
            }
            Text("Time", color = Palette.Muted, fontSize = 13.sp)
            when {
                slotErr != null -> ErrorText(slotErr)
                slots == null -> CircularProgressIndicator(color = Palette.Teal, modifier = Modifier.size(24.dp))
                slots!!.none { it.free } -> Text("No free slots on this day. Choose another day.", color = Palette.Muted)
                else -> FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    slots!!.forEach { s -> Choice(time12(s.time), time == s.time, enabled = s.free) { time = s.time } }
                }
            }
            OutlinedTextField(name, { name = it.take(60) }, label = { Text("Full name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(age, { age = it.filter(Char::isDigit).take(3) }, label = { Text("Age") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
                OutlinedTextField(phone, { phone = it.filter(Char::isDigit).take(10) }, label = { Text("Mobile number") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.weight(2f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("Male", "Female", "Other").forEach { s -> Choice(s, sex == s, modifier = Modifier.weight(1f)) { sex = s } }
            }
            Text("Language for the AI assistant and reminders", color = Palette.Muted, fontSize = 13.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("en" to "English", "ta" to "தமிழ்", "hi" to "हिन्दी").forEach { (k, l) -> Choice(l, lang == k, modifier = Modifier.weight(1f)) { lang = k } }
            }
            OutlinedTextField(reason, { reason = it.take(300) }, label = { Text("Reason for the visit") }, minLines = 2, modifier = Modifier.fillMaxWidth())
            Row(verticalAlignment = Alignment.Top, modifier = Modifier.clickable { consent = !consent }) {
                Checkbox(consent, { consent = it })
                Text("I agree that my details are stored so the clinic can manage my appointment and call me about it.", fontSize = 14.sp, modifier = Modifier.padding(top = 12.dp))
            }
            ErrorText(err)
            Button(
                onClick = {
                    err = when {
                        time.isBlank() -> "Choose a time."
                        name.isBlank() || age.isBlank() || sex.isBlank() -> "Fill in your name, age and sex."
                        phone.length != 10 -> "Enter a 10-digit mobile number."
                        !consent -> "Tick the box to agree, so the clinic can keep your booking."
                        else -> null
                    }
                    if (err == null) {
                        busy = true
                        scope.launch {
                            try {
                                val a = api.book(name.trim(), age, sex, phone, date, time, mode, reason.trim(), lang)
                                vm.prefs.saveBooking(MyBooking(a.code, phone, a.name, a.date, a.time, a.mode))
                                booked = a
                            } catch (e: Exception) {
                                err = e.message
                                runCatching { slots = api.slots(date) }
                            } finally { busy = false }
                        }
                    }
                },
                enabled = !busy, modifier = Modifier.fillMaxWidth().height(52.dp),
            ) { Text(if (busy) "Booking…" else "Confirm booking", fontSize = 17.sp) }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun MyAppointments(vm: CallViewModel, withMedia: (() -> Unit) -> Unit, onBack: () -> Unit, onBook: () -> Unit) {
    val api = remember { Api(vm.prefs.serverUrl) }
    var refresh by remember { mutableIntStateOf(0) }
    val bookings = remember(refresh) { vm.prefs.bookings() }
    val status = remember { mutableStateMapOf<String, Appt>() }
    val errors = remember { mutableStateMapOf<String, String>() }
    var addOpen by remember { mutableStateOf(false) }

    LaunchedEffect(refresh) {
        bookings.forEach { b ->
            try { status[b.code] = api.myAppointment(b.code, b.phone); errors.remove(b.code) }
            catch (e: Exception) { errors[b.code] = e.message ?: "Couldn't check this booking" }
        }
    }

    Column(Modifier.fillMaxSize()) {
        TopBar("My appointments", onBack) {
            IconButton(onClick = { refresh++ }) { Icon(Icons.Filled.Refresh, "Refresh") }
        }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (bookings.isEmpty()) item {
                Card {
                    Text("No appointments on this phone yet.", color = Palette.Muted)
                    Button(onClick = onBook) { Text("Book an appointment") }
                }
            }
            items(bookings, key = { it.code }) { b ->
                val a = status[b.code]
                val st = a?.status ?: "booked"
                Card {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("${dayLabel(b.date)}, ${time12(b.time)}", fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
                            Text("${if (b.mode == "tele") "Video teleconsult" else "Clinic visit"} · code ${b.code}", color = Palette.Muted, fontSize = 13.sp)
                        }
                        Pill(statusLabel(st), statusColor(st))
                    }
                    errors[b.code]?.let { ErrorText(it) }
                    if (b.mode == "tele" && (a == null || a.isOpen)) {
                        Button(
                            onClick = { withMedia { vm.startAsPatient(b.code, b.phone, b.name) } },
                            modifier = Modifier.fillMaxWidth().height(50.dp),
                        ) { Icon(Icons.Filled.Videocam, null); Spacer(Modifier.width(8.dp)); Text("Join video call", fontSize = 16.sp) }
                        Text("Join at your time. You'll wait until the doctor lets you in.", color = Palette.Muted, fontSize = 12.sp)
                    }
                    if (a != null && !a.isOpen) TextButton(onClick = { vm.prefs.removeBooking(b.code); refresh++ }) { Text("Remove from this list") }
                }
            }
            item {
                TextButton(onClick = { addOpen = true }) { Text("Booked at the clinic? Add it with your code") }
            }
        }
    }

    if (addOpen) {
        var code by remember { mutableStateOf("") }
        var phone by remember { mutableStateOf("") }
        var err by remember { mutableStateOf<String?>(null) }
        val scope = rememberCoroutineScope()
        AlertDialog(
            onDismissRequest = { addOpen = false },
            title = { Text("Add an appointment") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(code, { code = it.filter(Char::isDigit).take(6) }, label = { Text("Booking code") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                    OutlinedTextField(phone, { phone = it.filter(Char::isDigit).take(10) }, label = { Text("Mobile number") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone))
                    ErrorText(err)
                }
            },
            confirmButton = {
                Button(onClick = {
                    scope.launch {
                        try {
                            val a = api.myAppointment(code, phone)
                            vm.prefs.saveBooking(MyBooking(a.code, phone, a.name, a.date, a.time, a.mode))
                            addOpen = false; refresh++
                        } catch (e: Exception) { err = e.message }
                    }
                }) { Text("Add") }
            },
            dismissButton = { TextButton(onClick = { addOpen = false }) { Text("Cancel") } },
        )
    }
}

// ---------------- Doctor ----------------

@Composable
private fun DoctorLogin(vm: CallViewModel, onBack: () -> Unit, onIn: () -> Unit) {
    val scope = rememberCoroutineScope()
    var pin by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar("Doctor sign-in", onBack)
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Enter the doctor PIN.", color = Palette.Muted)
            OutlinedTextField(
                pin, { pin = it.filter(Char::isDigit).take(8) }, label = { Text("PIN") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword), modifier = Modifier.fillMaxWidth(),
            )
            ErrorText(err)
            Button(
                onClick = {
                    busy = true; err = null
                    scope.launch {
                        try {
                            val s = Api(vm.prefs.serverUrl).login("doctor", pin)
                            vm.prefs.saveSession("doctor", s.token)
                            vm.prefs.doctorName = s.doctorName
                            onIn()
                        } catch (e: Exception) { err = e.message } finally { busy = false }
                    }
                },
                enabled = pin.isNotBlank() && !busy, modifier = Modifier.fillMaxWidth().height(50.dp),
            ) { Text(if (busy) "Signing in…" else "Sign in") }
        }
    }
}

@Composable
private fun DoctorDay(vm: CallViewModel, withMedia: (() -> Unit) -> Unit, onBack: () -> Unit, onSignedOut: () -> Unit) {
    val session = vm.prefs.session("doctor") ?: run { LaunchedEffect(Unit) { onSignedOut() }; return }
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    var date by rememberSaveable { mutableStateOf(LocalDate.now().toString()) }
    var refresh by remember { mutableIntStateOf(0) }
    val list = remember { mutableStateListOf<Appt>() }
    var loading by remember { mutableStateOf(true) }
    var err by remember { mutableStateOf<String?>(null) }

    fun signOut() { vm.prefs.saveSession("doctor", null); onSignedOut() }

    LaunchedEffect(date, refresh, vm.state) {
        loading = true; err = null
        try { list.clear(); list.addAll(api.dayAppointments(session, date)) }
        catch (e: Exception) {
            if (e.message?.contains("Sign in", ignoreCase = true) == true) signOut() else err = e.message
        }
        loading = false
    }

    fun setStatus(a: Appt, s: String) = scope.launch {
        try { api.setStatus(session, a.id, s); refresh++ } catch (e: Exception) { err = e.message }
    }

    Column(Modifier.fillMaxSize()) {
        TopBar(vm.prefs.doctorName.ifBlank { "Doctor" }, onBack) {
            IconButton(onClick = { refresh++ }) { Icon(Icons.Filled.Refresh, "Refresh") }
            TextButton(onClick = { signOut() }) { Text("Sign out") }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { date = LocalDate.parse(date).minusDays(1).toString() }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Previous day") }
            Text("Appointments · ${dayLabel(date)}", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            IconButton(onClick = { date = LocalDate.parse(date).plusDays(1).toString() }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Next day") }
        }
        Box(Modifier.padding(horizontal = 16.dp)) { ErrorText(err) }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (loading && list.isEmpty()) item { CircularProgressIndicator(color = Palette.Teal) }
            if (!loading && list.isEmpty() && err == null) item { Text("No appointments on this day.", color = Palette.Muted) }
            items(list, key = { it.id }) { a ->
                Card {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(time12(a.time), fontFamily = FontFamily.Monospace, color = Palette.Teal, modifier = Modifier.width(76.dp))
                        Column(Modifier.weight(1f)) {
                            Text(a.name, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${a.age} y · ${a.sex} · ${if (a.isTele) "Video" else "Clinic"}", color = Palette.Muted, fontSize = 13.sp)
                        }
                        Pill(statusLabel(a.status), statusColor(a.status))
                    }
                    if (a.reason.isNotBlank()) Text(a.reason, fontSize = 14.sp)
                    if (a.isOpen) {
                        if (a.isTele) {
                            Button(
                                onClick = { withMedia { vm.startAsDoctor(session, a.id, a.name, vm.prefs.doctorName) } },
                                modifier = Modifier.fillMaxWidth(),
                            ) { Icon(Icons.Filled.Videocam, null); Spacer(Modifier.width(8.dp)); Text(if (a.status == "in-call") "Rejoin video call" else "Start video call") }
                        }
                        FlowRow2 {
                            if (!a.isTele && a.status == "booked") OutlinedButton(onClick = { setStatus(a, "arrived") }) { Text("Arrived") }
                            OutlinedButton(onClick = { setStatus(a, "completed") }) { Text("Completed") }
                            OutlinedButton(onClick = { setStatus(a, "no-show") }) { Text("No-show") }
                            TextButton(onClick = { setStatus(a, "cancelled") }, colors = ButtonDefaults.textButtonColors(contentColor = Palette.Red)) { Text("Cancel") }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlowRow2(content: @Composable () -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { content() }
}

@Suppress("unused")
private fun Modifier.outlined() = this.border(1.dp, Palette.CardHigh, RoundedCornerShape(12.dp))
