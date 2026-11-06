@file:OptIn(ExperimentalLayoutApi::class)

package com.shazverse.rxclinic.ui

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Badge
import androidx.compose.material.icons.filled.Biotech
import androidx.compose.material.icons.filled.PriceChange
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.WorkspacePremium
import androidx.compose.material.icons.automirrored.filled.ReceiptLong
import androidx.compose.material.icons.filled.LocalHospital
import androidx.compose.material.icons.filled.LocalPharmacy
import androidx.compose.material.icons.filled.MedicalServices
import androidx.compose.material.icons.filled.MonitorHeart
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ButtonDefaults
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.shazverse.rxclinic.Api
import com.shazverse.rxclinic.call.CallViewModel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** Staff roles and their display names. */
val ROLE_TITLES = linkedMapOf(
    "doctor" to "Doctor",
    "staff" to "Nursing staff",
    "pharmacy" to "Pharmacy",
    "lab" to "Lab",
    "diagnostics" to "Diagnostics",
    "billing" to "Billing",
    "admin" to "Admin",
)

private fun signedOutError(e: Exception) = e.message?.contains("Sign in", ignoreCase = true) == true

// ---------------- Staff sign-in: username and password ----------------

@Composable
fun StaffLogin(vm: CallViewModel, role: String, onBack: (() -> Unit)?, onIn: (String) -> Unit, onPatient: (() -> Unit)? = null, onSettings: (() -> Unit)? = null) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var username by remember { mutableStateOf(vm.prefs.staffUsername) }
    var password by remember { mutableStateOf("") }
    var show by remember { mutableStateOf(false) }
    var remember by remember { mutableStateOf(true) }
    var err by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var lic by remember { mutableStateOf<JSONObject?>(null) }
    var mustChange by remember { mutableStateOf<String?>(null) } // role, while the first-sign-in password change is open
    LaunchedEffect(Unit) { lic = runCatching { Api(vm.prefs.serverUrl).license() }.getOrNull() }

    fun login() {
        busy = true; err = null; info = null
        scope.launch {
            try {
                val s = Api(vm.prefs.serverUrl).login(username, password)
                vm.prefs.saveSession(s.role, s.token)
                vm.prefs.staffUsername = if (remember) s.username else ""
                vm.prefs.doctorName = s.name
                vm.prefs.staffQual = s.qual; vm.prefs.staffReg = s.reg
                vm.prefs.clinicJson = s.clinic.toString()
                runCatching { Api(vm.prefs.serverUrl).call("/api/plan", JSONObject().put("session", s.token)).optJSONObject("plan") }.getOrNull()?.let { vm.prefs.planJson = it.toString() }
                if (s.mustChange) mustChange = s.role else onIn(s.role)
            } catch (e: Exception) { err = e.message } finally { busy = false }
        }
    }

    Column(Modifier.fillMaxSize().background(Ui.Bg).imePadding()) {
        Row(Modifier.fillMaxWidth().padding(start = 4.dp, top = 4.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) TextButton(onClick = onBack) { Text("‹ Back", color = Ui.Teal) }
            Spacer(Modifier.weight(1f))
            if (onSettings != null) IconButton(onClick = onSettings) { Icon(Icons.Filled.Settings, "Settings", tint = Ui.Muted) }
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Column(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Ui.Card).border(1.dp, Ui.Line, RoundedCornerShape(12.dp)),
            ) {
                Column(Modifier.padding(horizontal = 22.dp, vertical = 26.dp), verticalArrangement = Arrangement.spacedBy(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("℞", color = Ui.Red, fontSize = 40.sp, fontFamily = FontFamily.Serif, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.width(6.dp))
                        Text("Rx Clinic", color = Ui.Teal, fontSize = 34.sp, fontFamily = FontFamily.Serif, fontWeight = FontWeight.Bold)
                    }
                    Text("HOSPITAL & CLINIC SUITE", color = Ui.Muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 3.sp)
                    Text("Sign in", color = Ui.Text, fontSize = 28.sp, fontWeight = FontWeight.SemiBold)
                    if (role.isNotBlank()) Text(ROLE_TITLES[role] ?: "Staff", color = Ui.Muted, fontSize = 14.sp)
                    OutlinedTextField(
                        username, { username = it.trim().lowercase().take(32) }, placeholder = { Text("Username") }, singleLine = true,
                        trailingIcon = { Icon(Icons.Filled.Person, null, tint = Ui.Muted) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = androidx.compose.ui.text.input.ImeAction.Next), modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        password, { password = it.take(72) }, placeholder = { Text("Password") }, singleLine = true,
                        visualTransformation = if (show) androidx.compose.ui.text.input.VisualTransformation.None else PasswordVisualTransformation(),
                        trailingIcon = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                TextButton(onClick = { show = !show }) { Text(if (show) "Hide" else "Show", fontSize = 12.sp, color = Ui.Muted) }
                                Icon(Icons.Filled.Key, null, tint = Ui.Muted, modifier = Modifier.padding(end = 12.dp))
                            }
                        },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                        keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { if (username.length >= 3 && password.isNotBlank() && !busy) login() }),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Row(Modifier.weight(1f).clickable { remember = !remember }, verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = remember, onCheckedChange = { remember = it })
                            Text("Remember me", color = Ui.Teal)
                        }
                        TextButton(onClick = {
                            runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(vm.prefs.serverUrl.trimEnd('/') + "/terms"))) }
                        }) { Icon(Icons.Filled.Description, null, tint = Ui.Teal, modifier = Modifier.size(18.dp)); Text(" Terms", color = Ui.Teal) }
                    }
                    err?.let { Text(it, color = Ui.Red, fontSize = 14.sp) }
                    info?.let { Text(it, color = Ui.Muted, fontSize = 14.sp) }
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        Button(
                            onClick = {
                                vm.prefs.staffRole?.let { vm.prefs.saveSession(it, null) }
                                password = ""; err = null; info = "Started a new session. Sign in again."
                            },
                            shape = RoundedCornerShape(0.dp), colors = ButtonDefaults.buttonColors(containerColor = Ui.Rose, contentColor = androidx.compose.ui.graphics.Color.White),
                            modifier = Modifier.fillMaxWidth(0.72f).height(50.dp),
                        ) { Text("NEW SESSION", fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp); Spacer(Modifier.width(10.dp)); Icon(Icons.Filled.Schedule, null, modifier = Modifier.size(18.dp)) }
                        Button(
                            onClick = { login() }, enabled = username.length >= 3 && password.isNotBlank() && !busy,
                            shape = RoundedCornerShape(0.dp), colors = ButtonDefaults.buttonColors(containerColor = Ui.Teal, contentColor = androidx.compose.ui.graphics.Color.White),
                            modifier = Modifier.fillMaxWidth(0.8f).height(52.dp),
                        ) { Text(if (busy) "SIGNING IN…" else "LOGIN", fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp); Spacer(Modifier.width(10.dp)); Icon(Icons.Filled.LockOpen, null, modifier = Modifier.size(18.dp)) }
                    }
                }
                Column(Modifier.fillMaxWidth().background(Ui.CardHigh).padding(horizontal = 22.dp, vertical = 18.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Share, null, tint = Ui.Teal, modifier = Modifier.size(18.dp))
                        Text("  LICENSED TO :", color = Ui.Teal, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp)
                    }
                    val l = lic
                    if (l == null) Text("Checking licence…", color = Ui.Muted)
                    else {
                        Text(l.str("licensedTo").ifBlank { "Rx Clinic" } + ",", color = Ui.Text)
                        if (l.str("address").isNotBlank()) Text(l.str("address"), color = Ui.Text)
                        Text(l.str("plan") + " plan" + if (l.optBoolean("trial")) " (trial)" else "", color = Ui.Text)
                        val d = runCatching { java.time.LocalDate.parse(l.str("expires")).format(java.time.format.DateTimeFormatter.ofPattern("dd MMM yyyy", java.util.Locale.ENGLISH)).uppercase() }.getOrDefault(l.str("expires"))
                        Text(androidx.compose.ui.text.buildAnnotatedString {
                            append(if (l.optBoolean("expired")) "License expired on " else "License expires on ")
                            pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Bold)); append(d); pop()
                        }, color = Ui.Red)
                    }
                }
            }
            if (onPatient != null) {
                Row(
                    Modifier.fillMaxWidth().padding(top = 14.dp).clip(RoundedCornerShape(12.dp)).background(Ui.Card).border(1.dp, Ui.Line, RoundedCornerShape(12.dp)).clickable(onClick = onPatient).padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.Person, null, tint = Ui.Teal)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(if (vm.prefs.patientSession != null) "Patient · ${vm.prefs.patientName}" else "I'm a patient", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                        Text("Register, check in, book, video consult, my records", color = Ui.Muted, fontSize = 13.sp)
                    }
                    Text("›", color = Ui.Teal, fontSize = 24.sp)
                }
                TextButton(onClick = { runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(vm.prefs.serverUrl.trimEnd('/') + "/home"))) } }) {
                    Text("About Rx Clinic · plans · free trial", color = Ui.Teal)
                }
            }
            Text("${java.time.Year.now()} © ShazVerse Technologies · Rx Clinic", color = Ui.Muted, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp, bottom = 24.dp))
        }
    }
    mustChange?.let { r ->
        ChangePasswordDialog(vm, knownOld = password, forced = true, onDone = { ok -> mustChange = null; if (ok) onIn(r) else vm.prefs.saveSession(r, null) })
    }
}

@Composable
internal fun PasswordField(value: String, onChange: (String) -> Unit, label: String) {
    OutlinedTextField(
        value, { onChange(it.take(72)) }, label = { Text(label) }, singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth(),
    )
}

/** Change the signed-in person's password. [knownOld] skips the current-password box. */
@Composable
internal fun ChangePasswordDialog(vm: CallViewModel, knownOld: String? = null, forced: Boolean = false, patient: Boolean = false, onDone: (Boolean) -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var old by remember { mutableStateOf("") }
    var new1 by remember { mutableStateOf("") }
    var new2 by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!forced) onDone(false) },
        title = { Text(if (forced) "Set your own password" else "Change password") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (forced) Text("This is your first sign-in. Choose a new password that only you know.", color = Ui.Muted, fontSize = 13.sp)
                if (knownOld == null) PasswordField(old, { old = it }, "Current password")
                PasswordField(new1, { new1 = it }, "New password (at least 6 characters)")
                PasswordField(new2, { new2 = it }, "New password again")
                ErrorText(err)
            }
        },
        confirmButton = {
            Button(enabled = !busy && new1.length >= 6, onClick = {
                if (new1 != new2) { err = "The two new passwords don't match"; return@Button }
                busy = true; err = null
                scope.launch {
                    try {
                        val session = if (patient) vm.prefs.patientSession else vm.prefs.staffRole?.let { vm.prefs.session(it) }
                        val token = Api(vm.prefs.serverUrl).changePassword(session.orEmpty(), knownOld ?: old, new1)
                        if (patient) vm.prefs.savePatient(token, vm.prefs.patientId, vm.prefs.patientName)
                        else vm.prefs.staffRole?.let { vm.prefs.saveSession(it, token) }
                        Toast.makeText(context, "Password changed", Toast.LENGTH_SHORT).show()
                        onDone(true)
                    } catch (e: Exception) { err = e.message }
                    busy = false
                }
            }) { Text("Save password") }
        },
        dismissButton = { TextButton(onClick = { onDone(false) }) { Text(if (forced) "Sign out" else "Cancel") } },
    )
}

/** Person icon in the top bar: who is signed in, change password, sign out. */
@Composable
internal fun AccountButton(vm: CallViewModel, onSignedOut: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    var changing by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }) { Icon(Icons.Filled.AccountCircle, "Account", tint = Ui.Text) }
    if (open) AlertDialog(
        onDismissRequest = { open = false },
        title = { Text(vm.prefs.doctorName.ifBlank { "Signed in" }) },
        text = {
            Text(listOf(vm.prefs.staffUsername, ROLE_TITLES[vm.prefs.staffRole.orEmpty()].orEmpty()).filter { it.isNotBlank() }.joinToString(" · "), color = Ui.Muted)
        },
        confirmButton = { TextButton(onClick = { open = false; changing = true }) { Text("Change password") } },
        dismissButton = {
            TextButton(onClick = { open = false; vm.prefs.staffRole?.let { vm.prefs.saveSession(it, null) }; onSignedOut() }) { Text("Sign out", color = Ui.Red) }
        },
    )
    if (changing) ChangePasswordDialog(vm, onDone = { changing = false })
}

// ---------------- Nursing staff: OPD triage vitals ----------------

@Composable
fun NurseScreen(vm: CallViewModel, onBack: () -> Unit, onPatients: () -> Unit, onInpatients: () -> Unit, onFollowUps: () -> Unit, onHmis: (String) -> Unit, onSignedOut: () -> Unit) {
    val session = vm.prefs.sessionFor("staff") ?: run { LaunchedEffect(Unit) { onSignedOut() }; return }
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var refresh by remember { mutableIntStateOf(0) }
    val list = remember { mutableStateListOf<JSONObject>() }
    var loading by remember { mutableStateOf(true) }
    var err by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<JSONObject?>(null) }

    LaunchedEffect(refresh) {
        loading = true; err = null
        try { val v = api.call("/api/nurse/queue", JSONObject().put("session", session)).objs("visits"); list.clear(); list.addAll(v) }
        catch (e: Exception) { if (signedOutError(e)) { vm.prefs.staffRole?.let { vm.prefs.saveSession(it, null) }; onSignedOut() } else err = e.message }
        loading = false
    }

    Column(Modifier.fillMaxSize()) {
        TopBar("Nursing · Triage", onBack) {
            IconButton(onClick = { refresh++ }) { Icon(Icons.Filled.Refresh, "Refresh", tint = Ui.Text) }
            AccountButton(vm, onSignedOut)
        }
        QuickLinks(buildList {
            add("Patients" to onPatients)
            if (vm.prefs.has("ip")) add("Inpatients" to onInpatients)
            add("Follow-ups" to onFollowUps)
            add("HMIS" to { onHmis("hmis") })
            if (vm.prefs.has("ip")) add("Bed board" to { onHmis("hmis:beds") })
            if (vm.prefs.has("homecare")) add("Home care" to { onHmis("hmis:homecare") })
            if (vm.prefs.has("mobileunit")) add("Camps" to { onHmis("hmis:camps") })
            if (vm.prefs.has("chat")) add("Messages" to { onHmis("hmis:messages") })
        })
        Text("Today's checked-in patients. Record vitals before they see the doctor; they appear on the doctor's case sheet. Mark emergencies so they go to the top of the doctor's queue.",
            color = Ui.Muted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp))
        Box(Modifier.padding(horizontal = 16.dp)) { ErrorText(err) }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (loading && list.isEmpty()) item { CircularProgressIndicator(color = Ui.Teal) }
            if (!loading && list.isEmpty() && err == null) item { Text("No patients have checked in today.", color = Ui.Muted) }
            items(list, key = { it.str("id") }) { v ->
                val p = v.obj("patient"); val tv = v.obj("triage")?.obj("vitals")
                RowCard(onClick = { editing = v }) {
                    Text(v.str("token"), color = Ui.Teal, fontSize = 22.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.width(44.dp))
                    Column(Modifier.weight(1f)) {
                        Text(p.str("name"), color = Ui.Text, fontWeight = FontWeight.SemiBold)
                        Text("${p.str("age")} y · ${p.str("sex")} · ${v.str("complaint")}", color = Ui.Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (tv != null) Text("BP ${tv.str("bp")} · PR ${tv.str("pulse")} · T ${tv.str("temp")} · SpO₂ ${tv.str("spo2")}", color = Ui.Text, fontSize = 13.sp, fontFamily = FontFamily.Monospace)
                    }
                    if (v.optBoolean("urgent")) Pill("Urgent", Ui.Red) else Pill(if (tv != null) "Vitals done" else "Vitals needed", if (tv != null) Ui.Green else Ui.Amber)
                }
            }
        }
    }

    editing?.let { v ->
        val prev = v.obj("triage")?.obj("vitals")
        val fields = listOf("bp" to "BP (mmHg)", "pulse" to "Pulse (/min)", "temp" to "Temp (°F)", "spo2" to "SpO₂ (%)", "rr" to "Resp. rate", "rbs" to "RBS (mg/dL)", "weight" to "Weight (kg)", "height" to "Height (cm)")
        val vals = remember(v) { mutableStateMapOf<String, String>().apply { fields.forEach { (k, _) -> put(k, prev.str(k)) } } }
        var note by remember(v) { mutableStateOf(v.obj("triage").str("note")) }
        var urgent by remember(v) { mutableStateOf(v.optBoolean("urgent")) }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("Vitals · ${v.obj("patient").str("name")}") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    fields.forEach { (k, l) ->
                        OutlinedTextField(vals[k].orEmpty(), { vals[k] = it.take(12) }, label = { Text(l) }, singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = if (k == "bp") KeyboardType.Text else KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
                    }
                    OutlinedTextField(note, { note = it.take(500) }, label = { Text("Nursing note") }, modifier = Modifier.fillMaxWidth())
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Emergency", color = if (urgent) Ui.Red else Ui.Text, fontWeight = FontWeight.SemiBold)
                            Text("Moves the patient to the top of the doctor's queue", color = Ui.Muted, fontSize = 12.sp)
                        }
                        Switch(checked = urgent, onCheckedChange = { urgent = it })
                    }
                }
            },
            confirmButton = {
                Button(onClick = {
                    scope.launch {
                        try {
                            val vo = JSONObject(); vals.forEach { (k, x) -> vo.put(k, x) }
                            api.call("/api/nurse/vitals", JSONObject().put("session", session).put("id", v.str("id")).put("vitals", vo).put("note", note).put("urgent", urgent))
                            Toast.makeText(context, "Vitals saved", Toast.LENGTH_SHORT).show()
                            editing = null; refresh++
                        } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't save", Toast.LENGTH_LONG).show() }
                    }
                }) { Text("Save vitals") }
            },
            dismissButton = { TextButton(onClick = { editing = null }) { Text("Cancel") } },
        )
    }
}

// ---------------- Pharmacy: dispensing and stock ----------------

@Composable
fun PharmacyScreen(vm: CallViewModel, onHmis: (String) -> Unit = {}, onBack: () -> Unit, onSignedOut: () -> Unit) {
    val session = vm.prefs.sessionFor("pharmacy") ?: run { LaunchedEffect(Unit) { onSignedOut() }; return }
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var tab by remember { mutableStateOf("dispense") }
    var refresh by remember { mutableIntStateOf(0) }
    val queue = remember { mutableStateListOf<JSONObject>() }
    val stock = remember { mutableStateListOf<JSONObject>() }
    var err by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var billFor by remember { mutableStateOf<String?>(null) } // visit id, or "" for a counter sale

    LaunchedEffect(refresh) {
        loading = true; err = null
        try {
            val q = api.call("/api/pharmacy/queue", JSONObject().put("session", session)).objs("queue")
            val s = api.call("/api/pharmacy/stock", JSONObject().put("session", session)).objs("stock")
            queue.clear(); queue.addAll(q); stock.clear(); stock.addAll(s)
        } catch (e: Exception) { if (signedOutError(e)) { vm.prefs.staffRole?.let { vm.prefs.saveSession(it, null) }; onSignedOut() } else err = e.message }
        loading = false
    }

    fun inStock(name: String): Boolean {
        val n = name.lowercase()
        return stock.any { val g = it.str("generic").lowercase(); g.length >= 4 && it.optInt("stock") > 0 && (n.contains(g) || g.contains(n)) }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar("Pharmacy", onBack) {
            IconButton(onClick = { refresh++ }) { Icon(Icons.Filled.Refresh, "Refresh", tint = Ui.Text) }
            AccountButton(vm, onSignedOut)
        }
        QuickLinks(listOf("Alerts: low stock & expiry" to { onHmis("hmis:pharmacy") }, "Purchases & batches" to { onHmis("hmis:pharmacy") }))
        Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice("To dispense (${queue.count { it.str("status") == "sent" }})", tab == "dispense", modifier = Modifier.weight(1f)) { tab = "dispense" }
            Choice("Bills", tab == "bills", modifier = Modifier.weight(1f)) { tab = "bills" }
            Choice("Stock (${stock.size})", tab == "stock", modifier = Modifier.weight(1f)) { tab = "stock" }
        }
        Box(Modifier.padding(horizontal = 16.dp)) { ErrorText(err) }
        if (tab == "dispense") {
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (loading && queue.isEmpty()) item { CircularProgressIndicator(color = Ui.Teal) }
                if (!loading && queue.isEmpty()) item { Text("No prescriptions yet. They appear here when the doctor taps Finish and save prescription.", color = Ui.Muted) }
                items(queue, key = { it.str("id") }) { v ->
                    val p = v.obj("patient"); val rx = v.obj("rx")
                    BoxCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("#${v.str("token")}  ${p.str("name")}", color = Ui.Text, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Pill(if (v.str("status") == "dispensed") "Dispensed" else "To dispense", if (v.str("status") == "dispensed") Ui.Green else Ui.Amber)
                        }
                        if (rx.str("dx").isNotBlank()) Text(rx.str("dx"), color = Ui.Muted, fontSize = 13.sp)
                        rx.objs("items").forEachIndexed { i, r ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text("${i + 1}. ${r.str("form")} ${r.str("generic")} ${r.str("strength")}", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                                    Text("${r.str("dose")} · ${r.str("frequency")} · ${r.str("timing")} · ${r.str("duration")}", color = Ui.Text, fontSize = 13.sp, fontFamily = FontFamily.Monospace)
                                    if (r.str("instructions").isNotBlank()) Text(r.str("instructions"), color = Ui.Muted, fontSize = 12.sp)
                                }
                                Pill(if (inStock(r.str("generic"))) "In stock" else "Not in stock", if (inStock(r.str("generic"))) Ui.Green else Ui.Red)
                            }
                        }
                        if (v.str("billId").isNotBlank()) Pill("Billed", Ui.Green)
                        if (v.str("status") == "sent") Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { billFor = v.str("id") }, modifier = Modifier.weight(1f)) { Text(if (v.str("billId").isBlank()) "Bill & dispense" else "Bill again") }
                            OutlinedButton(onClick = {
                                scope.launch {
                                    try {
                                        api.call("/api/pharmacy/dispense", JSONObject().put("session", session).put("id", v.str("id")))
                                        Toast.makeText(context, "Marked dispensed", Toast.LENGTH_SHORT).show(); refresh++
                                    } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't update", Toast.LENGTH_LONG).show() }
                                }
                            }) { Text("Dispense only") }
                        }
                    }
                }
            }
        } else if (tab == "bills") {
            BillsPanel(vm, session, "pharmacy", refresh, onNew = { billFor = "" }, newLabel = "New counter sale")
        } else {
            var generic by remember { mutableStateOf("") }
            var price by remember { mutableStateOf("") }
            var brand by remember { mutableStateOf("") }
            var form by remember { mutableStateOf("Tab") }
            var strength by remember { mutableStateOf("") }
            var units by remember { mutableStateOf("") }
            var bulk by remember { mutableStateOf("") }
            var search by remember { mutableStateOf("") }
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                item {
                    BoxCard {
                        Text("Add a medicine", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            OutlinedTextField(generic, { generic = it }, label = { Text("Generic") }, singleLine = true, modifier = Modifier.weight(1.4f))
                            OutlinedTextField(brand, { brand = it }, label = { Text("Brand") }, singleLine = true, modifier = Modifier.weight(1f))
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            OutlinedTextField(form, { form = it }, label = { Text("Form") }, singleLine = true, modifier = Modifier.weight(1f))
                            OutlinedTextField(strength, { strength = it }, label = { Text("Strength") }, singleLine = true, modifier = Modifier.weight(1f))
                            OutlinedTextField(units, { units = it.filter(Char::isDigit).take(6) }, label = { Text("Units") }, singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(0.8f))
                            OutlinedTextField(price, { price = it.filter { c -> c.isDigit() || c == '.' }.take(8) }, label = { Text("MRP ₹/unit") }, singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f))
                        }
                        Button(enabled = generic.isNotBlank(), onClick = {
                            scope.launch {
                                try {
                                    api.call("/api/pharmacy/stock/save", JSONObject().put("session", session).put("item",
                                        JSONObject().put("generic", generic.trim()).put("brand", brand.trim()).put("form", form.trim()).put("strength", strength.trim()).put("stock", units.toIntOrNull() ?: 0).put("price", price.toDoubleOrNull() ?: 0.0)))
                                    generic = ""; brand = ""; strength = ""; units = ""; price = ""; refresh++
                                } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't add", Toast.LENGTH_LONG).show() }
                            }
                        }) { Text("Add to stock") }
                        Text("Or paste a list (one per line: generic, brand, form, strength, units, MRP per unit). You can copy columns from Excel.", color = Ui.Muted, fontSize = 12.sp)
                        OutlinedTextField(bulk, { bulk = it }, label = { Text("Paste list") }, minLines = 2, modifier = Modifier.fillMaxWidth())
                        OutlinedButton(enabled = bulk.isNotBlank(), onClick = {
                            val arr = JSONArray()
                            bulk.lines().map { l -> l.split('\t', ',').map { it.trim() } }.filter { it.firstOrNull().orEmpty().isNotBlank() }.forEach { c ->
                                arr.put(JSONObject().put("generic", c[0]).put("brand", c.getOrElse(1) { "" }).put("form", c.getOrElse(2) { "Tab" })
                                    .put("strength", c.getOrElse(3) { "" }).put("stock", c.getOrElse(4) { "0" }.toIntOrNull() ?: 0).put("price", c.getOrElse(5) { "0" }.toDoubleOrNull() ?: 0.0))
                            }
                            scope.launch {
                                try {
                                    val r = api.call("/api/pharmacy/stock/save", JSONObject().put("session", session).put("items", arr))
                                    Toast.makeText(context, "Imported ${r.optInt("saved")} medicines", Toast.LENGTH_SHORT).show(); bulk = ""; refresh++
                                } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't import", Toast.LENGTH_LONG).show() }
                            }
                        }) { Text("Import list") }
                    }
                    OutlinedTextField(search, { search = it }, label = { Text("Search stock") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
                }
                items(stock.filter { search.isBlank() || (it.str("generic") + " " + it.str("brand")).contains(search, true) }, key = { it.str("id") }) { d ->
                    StockRow(d, onSave = { n, pr ->
                        scope.launch {
                            try { api.call("/api/pharmacy/stock/save", JSONObject().put("session", session).put("item", JSONObject(d.toString()).put("stock", n).put("price", pr))); refresh++ }
                            catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't update", Toast.LENGTH_LONG).show() }
                        }
                    }, onDelete = {
                        scope.launch {
                            try { api.call("/api/pharmacy/stock/delete", JSONObject().put("session", session).put("id", d.str("id"))); refresh++ }
                            catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't delete", Toast.LENGTH_LONG).show() }
                        }
                    })
                }
            }
        }
    }

    billFor?.let { vid ->
        BillEditor(vm, session, "pharmacy", visitId = vid, dispense = vid.isNotBlank(), onDismiss = { billFor = null }, onSaved = { b ->
            billFor = null; refresh++
            Toast.makeText(context, "Bill ${b.str("no")} saved · ${rupees(b.num("total"))}", Toast.LENGTH_LONG).show()
        })
    }
}

@Composable
private fun StockRow(d: JSONObject, onSave: (Int, Double) -> Unit, onDelete: () -> Unit) {
    var units by remember(d.str("id"), d.optInt("stock")) { mutableStateOf(d.optInt("stock").toString()) }
    var price by remember(d.str("id"), d.num("price")) { mutableStateOf(d.num("price").let { if (it % 1.0 == 0.0) it.toLong().toString() else it.toString() }) }
    BoxCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("${d.str("generic")} ${d.str("strength")}", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                Text(listOf(d.str("form"), d.str("brand")).filter { it.isNotBlank() }.joinToString(" · "), color = Ui.Muted, fontSize = 13.sp)
            }
            if (d.optInt("stock") <= 0) Pill("Out of stock", Ui.Red)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedTextField(units, { units = it.filter(Char::isDigit).take(6) }, label = { Text("Units") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.width(88.dp))
            OutlinedTextField(price, { price = it.filter { c -> c.isDigit() || c == '.' }.take(8) }, label = { Text("MRP ₹") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.width(96.dp))
            TextButton(onClick = { onSave(units.toIntOrNull() ?: 0, price.toDoubleOrNull() ?: 0.0) }) { Text("Save") }
            TextButton(onClick = onDelete) { Text("Delete", color = Ui.Red) }
        }
    }
}

// ---------------- Lab, and Diagnostics (USG, CT, MRI, PET-CT, X-ray) ----------------

@Composable
fun OrdersScreen(vm: CallViewModel, role: String, onHmis: (String) -> Unit = {}, onBack: () -> Unit, onSignedOut: () -> Unit) {
    val imaging = role == "diagnostics"
    val session = vm.prefs.sessionFor(role) ?: run { LaunchedEffect(Unit) { onSignedOut() }; return }
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var refresh by remember { mutableIntStateOf(0) }
    val list = remember { mutableStateListOf<JSONObject>() }
    var loading by remember { mutableStateOf(true) }
    var err by remember { mutableStateOf<String?>(null) }
    var filter by remember { mutableStateOf("All") }
    var reporting by remember { mutableStateOf<JSONObject?>(null) }
    var tab by remember { mutableStateOf("orders") }
    var billVisit by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(refresh) {
        loading = true; err = null
        try {
            val o = api.call("/api/orders/list", JSONObject().put("session", session).put("kind", if (imaging) "imaging" else "lab")).objs("orders")
            list.clear(); list.addAll(o)
        } catch (e: Exception) { if (signedOutError(e)) { vm.prefs.staffRole?.let { vm.prefs.saveSession(it, null) }; onSignedOut() } else err = e.message }
        loading = false
    }

    fun update(o: JSONObject, status: String) = scope.launch {
        try {
            api.call("/api/orders/update", JSONObject().put("session", session).put("id", o.str("id")).put("status", status))
            refresh++
        } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't update", Toast.LENGTH_LONG).show() }
    }

    val modalities = listOf("All", "USG", "CT", "MRI", "PET-CT", "X-ray", "Mammogram", "Endoscopy")
    val shown = list.filter { !imaging || filter == "All" || it.str("modality") == filter }
    Column(Modifier.fillMaxSize()) {
        TopBar(if (imaging) "Diagnostics" else "Lab", onBack) {
            IconButton(onClick = { refresh++ }) { Icon(Icons.Filled.Refresh, "Refresh", tint = Ui.Text) }
            AccountButton(vm, onSignedOut)
        }
        QuickLinks(listOf("Upload report photos / PDFs" to { onHmis("hmis:lab") }))
        Text(if (imaging) "Scan orders from the doctors. Schedule the scan, then enter findings and impression; the report reaches the doctor's case sheet."
            else "Test orders from the doctors. Mark the sample collected, then enter the report; it reaches the doctor's case sheet.",
            color = Ui.Muted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp))
        Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice("Orders", tab == "orders", modifier = Modifier.weight(1f)) { tab = "orders" }
            Choice("Bills", tab == "bills", modifier = Modifier.weight(1f)) { tab = "bills" }
        }
        if (tab == "bills") { BillsPanel(vm, session, role, refresh, onNew = { billVisit = "" }, newLabel = "New bill (walk-in)"); return@Column }
        if (imaging) FlowRow(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            modalities.forEach { m ->
                val n = if (m == "All") list.count { it.str("status") != "reported" } else list.count { it.str("modality") == m && it.str("status") != "reported" }
                Choice(if (n > 0) "$m ($n)" else m, filter == m) { filter = m }
            }
        }
        Box(Modifier.padding(horizontal = 16.dp)) { ErrorText(err) }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (loading && list.isEmpty()) item { CircularProgressIndicator(color = Ui.Teal) }
            if (!loading && shown.isEmpty() && err == null) item { Text("No orders right now. They appear when a doctor sends tests from the case sheet.", color = Ui.Muted) }
            items(shown, key = { it.str("id") }) { o ->
                val p = o.obj("patient"); val st = o.str("status")
                BoxCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(o.str("test"), color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                            Text("${p.str("name")} · ${p.str("age")} y ${p.str("sex")} · token ${o.str("token")} · ${dayLabel(o.str("date"))}", color = Ui.Muted, fontSize = 13.sp)
                        }
                        if (imaging) { Pill(o.str("modality"), Ui.Ai); Spacer(Modifier.width(4.dp)) }
                        Pill(orderStatusLabel(st), if (st == "reported") Ui.Green else Ui.Amber)
                    }
                    if (o.str("billId").isNotBlank()) Pill("Billed", Ui.Green)
                    else TextButton(onClick = { billVisit = o.str("visitId") }) { Text("Bill this patient's ${if (imaging) "scans" else "tests"}") }
                    when (st) {
                        "ordered" -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { update(o, if (imaging) "scheduled" else "collected") }) { Text(if (imaging) "Scan scheduled" else "Sample collected") }
                            OutlinedButton(onClick = { reporting = o }) { Text("Enter report") }
                        }
                        "collected", "scheduled" -> Button(onClick = { reporting = o }, modifier = Modifier.fillMaxWidth()) { Text("Enter report") }
                        else -> {
                            if (o.str("result").isNotBlank()) Text(o.str("result"), color = Ui.Text, fontSize = 13.sp)
                            if (o.str("impression").isNotBlank()) Text("Impression: " + o.str("impression"), color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                        }
                    }
                }
            }
        }
    }

    billVisit?.let { vid ->
        BillEditor(vm, session, role, visitId = vid, onDismiss = { billVisit = null }, onSaved = { b ->
            billVisit = null; refresh++
            Toast.makeText(context, "Bill ${b.str("no")} saved · ${rupees(b.num("total"))}", Toast.LENGTH_LONG).show()
        })
    }

    reporting?.let { o ->
        var result by remember(o) { mutableStateOf("") }
        var impression by remember(o) { mutableStateOf("") }
        var saving by remember(o) { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { reporting = null },
            title = { Text("Report · ${o.str("test")}") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(o.obj("patient").str("name"), color = Ui.Muted)
                    OutlinedTextField(result, { result = it }, label = { Text(if (imaging) "Findings" else "Results (values with units)") }, minLines = 5, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(impression, { impression = it }, label = { Text(if (imaging) "Impression" else "Comment (optional)") }, minLines = 2, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = {
                Button(enabled = !saving && (result.isNotBlank() || impression.isNotBlank()), onClick = {
                    saving = true
                    scope.launch {
                        try {
                            api.call("/api/orders/update", JSONObject().put("session", session).put("id", o.str("id")).put("status", "reported").put("result", result).put("impression", impression))
                            Toast.makeText(context, "Report sent to the doctor", Toast.LENGTH_SHORT).show()
                            reporting = null; refresh++
                        } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't save", Toast.LENGTH_LONG).show() }
                        saving = false
                    }
                }) { Text("Send report") }
            },
            dismissButton = { TextButton(onClick = { reporting = null }) { Text("Cancel") } },
        )
    }
}

// ---------------- Admin ----------------

@Composable
fun AdminScreen(vm: CallViewModel, onBack: () -> Unit, onOpen: (String) -> Unit, onSignedOut: () -> Unit) {
    val session = vm.prefs.session("admin") ?: run { LaunchedEffect(Unit) { onSignedOut() }; return }
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var refresh by remember { mutableIntStateOf(0) }
    var ov by remember { mutableStateOf<JSONObject?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    val users = remember { mutableStateListOf<JSONObject>() }
    val clinic = remember { mutableStateMapOf<String, String>() }
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    var qr by remember { mutableStateOf(false) }
    var leads by remember { mutableStateOf(false) }

    LaunchedEffect(refresh) {
        err = null
        try {
            ov = api.call("/api/admin/overview", JSONObject().put("session", session))
            val st = api.call("/api/settings", JSONObject().put("session", session))
            val u = api.call("/api/admin/users", JSONObject().put("session", session)).objs("users")
            users.clear(); users.addAll(u)
            st.obj("clinic")?.let { c -> c.keys().forEach { k -> clinic[k] = c.str(k) } }
        } catch (e: Exception) { if (signedOutError(e)) { vm.prefs.staffRole?.let { vm.prefs.saveSession(it, null) }; onSignedOut() } else err = e.message }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar("Admin", onBack) {
            IconButton(onClick = { refresh++ }) { Icon(Icons.Filled.Refresh, "Refresh", tint = Ui.Text) }
            AccountButton(vm, onSignedOut)
        }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { ErrorText(err) }
            item {
                val o = ov
                Text("Today", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, fontFamily = FontFamily.Serif)
                if (o == null) CircularProgressIndicator(color = Ui.Teal) else FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Stat("OPD checked in", o.obj("opd").str("checkedIn"), "${o.obj("opd").str("waiting")} waiting · ${o.obj("opd").str("urgent")} urgent")
                    Stat("Prescribed", o.obj("opd").str("prescribed"), "${o.obj("pharmacy").str("toDispense")} to dispense")
                    Stat("Appointments", o.obj("appointments").str("total"), "${o.obj("appointments").str("tele")} video")
                    Stat("Lab", o.obj("lab").str("pending"), "pending · ${o.obj("lab").str("reported")} reported")
                    Stat("Diagnostics", o.obj("diagnostics").str("pending"), "pending · ${o.obj("diagnostics").str("reported")} reported")
                    Stat("Out of stock", o.obj("pharmacy").str("outOfStock"), "medicines")
                    Stat("Patients", o.obj("people").str("patients"), "registered")
                    Stat("Billed today", rupees(o.obj("billing").num("billed")), "collected ${rupees(o.obj("billing").num("collected"))}")
                    Stat("Inpatients", o.obj("billing").str("inpatients"), "admitted now")
                }
            }
            item {
                Text("Open a section", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, fontFamily = FontFamily.Serif)
                Text("As admin you can open every section.", color = Ui.Muted, fontSize = 13.sp)
            }
            item { RoleCard("Doctor", "OPD, case sheets, appointments, video", Icons.Filled.MedicalServices) { onOpen("doctor") } }
            item { RoleCard("Nursing staff", "Triage vitals", Icons.Filled.LocalHospital) { onOpen("staff") } }
            item { RoleCard("Pharmacy", "Dispensing and stock", Icons.Filled.LocalPharmacy) { onOpen("pharmacy") } }
            item { RoleCard("Patient records", "Register, find and edit patients", Icons.Filled.Badge) { onOpen("patients") } }
            item { RoleCard("Billing", "OPD bills, patient totals, inpatients, collections", Icons.AutoMirrored.Filled.ReceiptLong) { onOpen("billing") } }
            item { RoleCard("Price list", "Consultation, tests, scans, rooms and inpatient charges", Icons.Filled.PriceChange) { onOpen("prices") } }
            item { RoleCard("Plan", "Bronze, Silver, Gold or Platinum; add-ons; logins in use", Icons.Filled.WorkspacePremium) { onOpen("plan") } }
            item { RoleCard("Clinic QR code", "Patients scan to book; print a poster for the desk", Icons.Filled.QrCode2) { qr = true } }
            item { RoleCard("Free trial requests", "Clinics that asked for a trial on the website", Icons.Filled.Inbox) { leads = true } }
            item { RoleCard("HMIS workspace", "Doctor's dashboard and patient charts, as on the website", Icons.Filled.Dashboard) { onOpen("hmis") } }
            item { RoleCard("Web portal", "Sign in from any computer or browser: ${vm.prefs.serverUrl.trimEnd('/')}/login", Icons.Filled.Language) {
                runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(vm.prefs.serverUrl.trimEnd('/') + "/login"))) }
            } }
            item { RoleCard("Lab", "Test orders and reports", Icons.Filled.Biotech) { onOpen("lab") } }
            item { RoleCard("Diagnostics", "USG, CT, MRI, PET-CT, X-ray", Icons.Filled.MonitorHeart) { onOpen("diagnostics") } }
            item {
                BoxCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Staff logins (${users.count { it.optBoolean("active") }})", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, modifier = Modifier.weight(1f))
                        Button(onClick = { editing = JSONObject().put("role", "doctor").put("active", true) }) { Text("Add login") }
                    }
                    Text("Make one login for each person. Several doctors, nurses or lab staff can work at the same time, each with their own password.", color = Ui.Muted, fontSize = 13.sp)
                    ROLE_TITLES.forEach { (role, title) ->
                        val list = users.filter { it.str("role") == role }
                        if (list.isNotEmpty()) {
                            Text(title.uppercase(), color = Ui.Muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 6.dp))
                            list.forEach { u ->
                                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { editing = u }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(1f)) {
                                        Text(u.str("name"), color = Ui.Text, fontWeight = FontWeight.SemiBold)
                                        Text(u.str("username") + (if (u.optBoolean("mustChange")) " · must set own password" else ""), color = Ui.Muted, fontSize = 13.sp)
                                    }
                                    if (!u.optBoolean("active")) Pill("Disabled", Ui.Muted)
                                }
                            }
                        }
                    }
                }
            }
            item {
                BoxCard {
                    Text("Clinic details (prescription letterhead)", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
                    listOf("name" to "Clinic name", "doctor" to "Doctor", "qual" to "Qualification", "reg" to "Registration number", "phone" to "Phone", "hours" to "OPD hours", "address" to "Address", "upi" to "UPI ID for payments (e.g. clinic@okhdfc)", "gstin" to "GSTIN (optional)").forEach { (k, l) ->
                        OutlinedTextField(clinic[k].orEmpty(), { clinic[k] = it.take(200) }, label = { Text(l) }, singleLine = k != "address", modifier = Modifier.fillMaxWidth())
                    }
                    Button(onClick = {
                        scope.launch {
                            try {
                                val c = JSONObject(); clinic.forEach { (k, x) -> c.put(k, x) }
                                api.call("/api/settings", JSONObject().put("session", session).put("clinic", c))
                                Toast.makeText(context, "Clinic details saved", Toast.LENGTH_SHORT).show()
                            } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't save", Toast.LENGTH_LONG).show() }
                        }
                    }) { Text("Save clinic details") }
                }
            }
        }
    }

    if (qr) ClinicQrDialog(vm, onDismiss = { qr = false })
    if (leads) LeadsDialog(vm, session, onDismiss = { leads = false })
    editing?.let { u ->
        UserDialog(vm, session, u, onDone = { changed -> editing = null; if (changed) { refresh++; Toast.makeText(context, "Login saved", Toast.LENGTH_SHORT).show() } })
    }
}

@Composable
private fun UserDialog(vm: CallViewModel, session: String, start: JSONObject, onDone: (Boolean) -> Unit) {
    val scope = rememberCoroutineScope()
    val isNew = start.str("id").isBlank()
    var name by remember { mutableStateOf(start.str("name")) }
    var username by remember { mutableStateOf(start.str("username")) }
    var role by remember { mutableStateOf(start.str("role").ifBlank { "doctor" }) }
    var qual by remember { mutableStateOf(start.str("qual")) }
    var reg by remember { mutableStateOf(start.str("reg")) }
    var phone by remember { mutableStateOf(start.str("phone")) }
    var active by remember { mutableStateOf(start.optBoolean("active", true)) }
    var branch by remember { mutableStateOf(start.str("branch")) }
    var password by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { onDone(false) },
        title = { Text(if (isNew) "New login" else "Edit login") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it.take(80) }, label = { Text("Full name (shown on prescriptions)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(username, { username = it.trim().lowercase().filter { c -> c.isLetterOrDigit() || c in "._-" }.take(32) }, label = { Text("Username") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii), modifier = Modifier.fillMaxWidth())
                Text("Role", color = Ui.Muted, fontSize = 13.sp)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    ROLE_TITLES.forEach { (k, t) -> Choice(t, role == k) { role = k } }
                }
                if (role == "doctor") {
                    OutlinedTextField(qual, { qual = it.take(80) }, label = { Text("Qualification, e.g. MBBS, MS") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(reg, { reg = it.take(40) }, label = { Text("Registration number") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                }
                OutlinedTextField(phone, { phone = it.filter(Char::isDigit).take(10) }, label = { Text("Mobile (optional)") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(branch, { branch = it.take(40) }, label = { Text("Branch (if you have several)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                PasswordField(password, { password = it }, if (isNew) "Starting password (at least 6)" else "New password (leave empty to keep)")
                Text("They will be asked to choose their own password at first sign-in.", color = Ui.Muted, fontSize = 12.sp)
                if (!isNew) Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Login active", color = Ui.Text, modifier = Modifier.weight(1f))
                    Switch(checked = active, onCheckedChange = { active = it })
                }
                ErrorText(err)
            }
        },
        confirmButton = {
            Button(enabled = !busy && name.isNotBlank() && username.length >= 3 && (!isNew || password.length >= 6), onClick = {
                busy = true; err = null
                scope.launch {
                    try {
                        val u = JSONObject().put("name", name.trim()).put("username", username).put("role", role).put("qual", qual).put("reg", reg)
                            .put("phone", phone).put("active", active).put("branch", branch)
                        if (!isNew) u.put("id", start.str("id"))
                        if (password.isNotBlank()) u.put("password", password)
                        Api(vm.prefs.serverUrl).call("/api/admin/users/save", JSONObject().put("session", session).put("user", u))
                        onDone(true)
                    } catch (e: Exception) { err = e.message }
                    busy = false
                }
            }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = { onDone(false) }) { Text("Cancel") } },
    )
}

// ---------------- small shared pieces ----------------

@Composable
internal fun Stat(label: String, value: String, sub: String) {
    Column(
        Modifier.width(150.dp).clip(RoundedCornerShape(14.dp)).background(Ui.Card).border(1.dp, Ui.Line, RoundedCornerShape(14.dp)).padding(12.dp),
    ) {
        Text(label.uppercase(), color = Ui.Muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        Text(value.ifBlank { "0" }, color = Ui.Text, fontSize = if (value.length > 6) 20.sp else 28.sp, fontFamily = FontFamily.Monospace, maxLines = 1)
        Text(sub, color = Ui.Muted, fontSize = 12.sp)
    }
}

@Composable
internal fun BoxCard(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Ui.Card).border(1.dp, Ui.Line, RoundedCornerShape(16.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) { content() }
}

@Composable
internal fun RowCard(onClick: (() -> Unit)? = null, content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    val base = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Ui.Card).border(1.dp, Ui.Line, RoundedCornerShape(16.dp))
    Row(
        (if (onClick != null) base.clickable(onClick = onClick) else base).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) { content() }
}

/** A row of quick shortcuts under the top bar. */
@Composable
internal fun QuickLinks(links: List<Pair<String, () -> Unit>>) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        links.forEach { (label, go) -> OutlinedButton(onClick = go, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp)) { Text(label, fontSize = 13.sp) } }
    }
}
