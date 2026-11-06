@file:OptIn(ExperimentalLayoutApi::class)

package com.shazverse.rxclinic.ui

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Refresh
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.shazverse.rxclinic.Api
import com.shazverse.rxclinic.call.CallViewModel
import com.shazverse.rxclinic.call.shareText
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.format.DateTimeFormatter

// ---------------- Certificates, referral letters, timeslips ----------------

private val LETTER_TYPES = listOf("certificate" to "Medical certificate", "fitness" to "Fitness certificate", "referral" to "Referral letter", "timeslip" to "Timeslip")

/**
 * Write and print a document for a patient. [patient] carries id, name, age, sex.
 * [dx] and [summary] pre-fill the certificate and referral letter from the case sheet.
 */
@Composable
fun LetterDialog(vm: CallViewModel, session: String, patient: JSONObject, visitId: String = "", dx: String = "", summary: String = "", onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val isDoctor = vm.prefs.staffRole == "doctor" || vm.prefs.staffRole == "admin"
    var type by remember { mutableStateOf(if (isDoctor) "certificate" else "timeslip") }
    val today = LocalDate.now()
    val f = remember { mutableStateMapOf(
        "diagnosis" to dx, "from" to today.toString(), "to" to today.plusDays(2).toString(), "remarks" to "",
        "purpose" to "resume duty", "toWhom" to "", "reason" to "", "summary" to summary, "timeFrom" to "", "timeTo" to "", "visitPurpose" to "consultation and treatment",
    ) }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val name = patient.str("name"); val who = "$name${if (patient.str("age").isNotBlank()) ", aged ${patient.str("age")}" else ""}${if (patient.str("id").isNotBlank()) " (Patient ID ${patient.str("id")})" else ""}"
    val days = runCatching { java.time.temporal.ChronoUnit.DAYS.between(LocalDate.parse(f["from"]), LocalDate.parse(f["to"])) + 1 }.getOrDefault(0L)
    val clinic = runCatching { JSONObject(vm.prefs.clinicJson).optString("name") }.getOrDefault("").ifBlank { "Rx Clinic" }

    fun text(): String = when (type) {
        "certificate" -> "This is to certify that $who was examined by me on ${longDate(today.toString())} and is suffering from ${f["diagnosis"]}.\n" +
            "The patient is advised rest for $days day${if (days == 1L) "" else "s"}, from ${longDate(f["from"].orEmpty())} to ${longDate(f["to"].orEmpty())}.\n" + f["remarks"].orEmpty()
        "fitness" -> "This is to certify that $who was examined by me on ${longDate(today.toString())} and is found medically fit to ${f["purpose"]} from ${longDate(f["from"].orEmpty())}.\n" + f["remarks"].orEmpty()
        "referral" -> "To ${f["toWhom"].orEmpty().ifBlank { "the concerned doctor" }},\n" +
            "Kindly see $who for ${f["reason"]}.\n" + (if (f["summary"].orEmpty().isNotBlank()) "Clinical summary: ${f["summary"]}\n" else "") +
            "Thank you for seeing this patient. I would be grateful for your opinion and further management."
        else -> "This is to certify that $who attended $clinic on ${longDate(f["from"].orEmpty())}" +
            (if (f["timeFrom"].orEmpty().isNotBlank()) " from ${f["timeFrom"]} to ${f["timeTo"]}" else "") + " for ${f["visitPurpose"]}."
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Certificate or letter") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(who, color = Ui.Muted, fontSize = 13.sp)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    LETTER_TYPES.filter { isDoctor || it.first == "timeslip" }.forEach { (k, l) -> Choice(l, type == k) { type = k } }
                }
                when (type) {
                    "certificate" -> { LField(f, "diagnosis", "Diagnosis"); Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(f["from"].orEmpty(), { f["from"] = it.take(10) }, label = { Text("Rest from") }, singleLine = true, modifier = Modifier.weight(1f))
                        OutlinedTextField(f["to"].orEmpty(), { f["to"] = it.take(10) }, label = { Text("Rest to") }, singleLine = true, modifier = Modifier.weight(1f)) }
                        Text("$days day${if (days == 1L) "" else "s"} of rest", color = Ui.Muted, fontSize = 12.sp); LField(f, "remarks", "Remarks (optional)", 2) }
                    "fitness" -> { LField(f, "purpose", "Fit to (resume duty, travel, sports…)"); LField(f, "from", "From date (YYYY-MM-DD)"); LField(f, "remarks", "Remarks (optional)", 2) }
                    "referral" -> { LField(f, "toWhom", "To (doctor, department or hospital)"); LField(f, "reason", "Reason for referral"); LField(f, "summary", "Clinical summary", 4) }
                    else -> { LField(f, "from", "Date (YYYY-MM-DD)"); Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(f["timeFrom"].orEmpty(), { f["timeFrom"] = it.take(8) }, label = { Text("From time") }, singleLine = true, modifier = Modifier.weight(1f))
                        OutlinedTextField(f["timeTo"].orEmpty(), { f["timeTo"] = it.take(8) }, label = { Text("To time") }, singleLine = true, modifier = Modifier.weight(1f)) }
                        LField(f, "visitPurpose", "Purpose") }
                }
                Text("Preview", color = Ui.Muted, fontSize = 12.sp)
                Text(text(), color = Ui.Text, fontSize = 13.sp)
                ErrorText(err)
            }
        },
        confirmButton = {
            Button(enabled = !busy, onClick = {
                busy = true; err = null
                scope.launch {
                    try {
                        val fields = JSONObject(); f.forEach { (k, v) -> fields.put(k, v) }; fields.put("text", text())
                        val l = Api(vm.prefs.serverUrl).call("/api/letters/save", JSONObject().put("session", session).put("letter",
                            JSONObject().put("type", type).put("patient", patient).put("patientId", patient.str("id")).put("visitId", visitId).put("fields", fields))).getJSONObject("letter")
                        Printer.print(context, l.str("title") + " " + l.str("no"), letterHtml(vm.prefs, l))
                        onDismiss()
                    } catch (e: Exception) { err = e.message }
                    busy = false
                }
            }) { Text("Save & print / PDF") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun LField(f: MutableMap<String, String>, k: String, label: String, lines: Int = 1) {
    OutlinedTextField(f[k].orEmpty(), { f[k] = it.take(1500) }, label = { Text(label) }, singleLine = lines == 1, minLines = lines, modifier = Modifier.fillMaxWidth())
}

// ---------------- Follow-ups (review dates) and call-backs ----------------

private fun dial(context: android.content.Context, phone: String) {
    if (phone.isBlank()) return
    runCatching { context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone"))) }
}

private val FOLLOW_STATUS = listOf("due" to "Due", "called" to "Called", "no-answer" to "No answer", "booked" to "Booked", "came" to "Came", "not-coming" to "Not coming")
private fun followColor(s: String) = when (s) { "came", "booked" -> Ui.Green; "no-answer", "not-coming" -> Ui.Red; "called" -> Ui.Ai; else -> Ui.Amber }

@Composable
fun FollowUpsScreen(vm: CallViewModel, onBack: () -> Unit, onSignedOut: () -> Unit) {
    val session = vm.prefs.sessionFor("staff") ?: vm.prefs.sessionFor("doctor") ?: vm.prefs.sessionFor("billing") ?: run { LaunchedEffect(Unit) { onSignedOut() }; return }
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var tab by remember { mutableStateOf("reviews") }
    var range by remember { mutableStateOf("today") }
    var tick by remember { mutableIntStateOf(0) }
    val follow = remember { mutableStateListOf<JSONObject>() }
    val calls = remember { mutableStateListOf<JSONObject>() }
    var err by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var adding by remember { mutableStateOf(false) }
    var noteFor by remember { mutableStateOf<Pair<String, String>?>(null) } // (kind:id, status)
    val today = LocalDate.now()

    LaunchedEffect(tab, range, tick) {
        loading = true; err = null
        try {
            if (tab == "reviews") {
                val (from, to) = when (range) { "today" -> today.minusDays(60) to today; "week" -> today.plusDays(1) to today.plusDays(7); else -> today.minusDays(60) to today.plusDays(30) }
                val r = api.call("/api/followups", JSONObject().put("session", session).put("from", from.toString()).put("to", to.toString())).objs("followups")
                follow.clear(); follow.addAll(if (range == "today") r.filter { it.obj("follow").str("status") !in setOf("came", "booked", "not-coming") } else r)
            } else {
                val r = api.call("/api/callbacks/list", JSONObject().put("session", session).put("status", if (range == "done") "done" else "open")).objs("callbacks")
                calls.clear(); calls.addAll(r)
            }
        } catch (e: Exception) { err = e.message }
        loading = false
    }

    fun setFollow(visitId: String, status: String, note: String = "") = scope.launch {
        try { api.call("/api/followups/update", JSONObject().put("session", session).put("visitId", visitId).put("status", status).put("note", note)); tick++ }
        catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't save", Toast.LENGTH_LONG).show() }
    }
    fun saveCall(body: JSONObject) = scope.launch {
        try { api.call("/api/callbacks/save", JSONObject().put("session", session).put("callback", body)); tick++ }
        catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't save", Toast.LENGTH_LONG).show() }
    }

    Column(Modifier.fillMaxSize()) {
        TopBar("Follow-ups", onBack) { IconButton(onClick = { tick++ }) { Icon(Icons.Filled.Refresh, "Refresh", tint = Ui.Text) } }
        Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice("Review dates", tab == "reviews", modifier = Modifier.weight(1f)) { tab = "reviews"; range = "today" }
            Choice("Call-backs", tab == "calls", modifier = Modifier.weight(1f)) { tab = "calls"; range = "open" }
        }
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            val opts = if (tab == "reviews") listOf("today" to "Due & overdue", "week" to "Next 7 days", "all" to "All") else listOf("open" to "To call", "done" to "Done")
            opts.forEach { (k, l) -> Choice(l, range == k) { range = k } }
        }
        Column(Modifier.padding(horizontal = 16.dp)) { ErrorText(err) }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (tab == "calls" && range == "open") item { Button(onClick = { adding = true }, modifier = Modifier.fillMaxWidth()) { Text("Add a call-back") } }
            if (loading) item { CircularProgressIndicator(color = Ui.Teal) }
            if (!loading && tab == "reviews" && follow.isEmpty()) item { Text(if (range == "today") "No reviews due. Everyone is on track." else "No reviews in this period.", color = Ui.Muted) }
            if (!loading && tab == "calls" && calls.isEmpty()) item { Text("No call-backs.", color = Ui.Muted) }
            if (tab == "reviews") items(follow, key = { it.str("visitId") }) { f ->
                val p = f.obj("patient"); val st = f.obj("follow").str("status").ifBlank { "due" }
                val overdue = f.str("review") < today.toString() && st == "due"
                BoxCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(p.str("name") + if (p.str("id").isNotBlank()) " · ${p.str("id")}" else "", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                            Text("Review ${dayLabel(f.str("review"))}${if (overdue) " · overdue" else ""} · seen ${dayLabel(f.str("visitDate"))}", color = if (overdue) Ui.Red else Ui.Muted, fontSize = 12.sp)
                        }
                        Pill(FOLLOW_STATUS.toMap()[st] ?: st, followColor(st))
                    }
                    if (f.str("dx").isNotBlank()) Text(f.str("dx"), color = Ui.Text, fontSize = 13.sp)
                    if (f.str("reviewNote").isNotBlank()) Text("Note: " + f.str("reviewNote"), color = Ui.Muted, fontSize = 13.sp)
                    if (f.obj("follow").str("note").isNotBlank()) Text("Last call: " + f.obj("follow").str("note"), color = Ui.Muted, fontSize = 12.sp)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (p.str("phone").isNotBlank()) Button(onClick = { dial(context, p.str("phone")) }) { Icon(Icons.Filled.Call, null); Text(" ${p.str("phone")}") }
                        FOLLOW_STATUS.filter { it.first != "due" && it.first != st }.forEach { (k, l) -> OutlinedButton(onClick = { noteFor = "f:${f.str("visitId")}" to k }) { Text(l, fontSize = 12.sp) } }
                    }
                }
            } else items(calls, key = { it.str("id") }) { c ->
                val p = c.obj("patient")
                BoxCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(p.str("name") + if (p.str("id").isNotBlank()) " · ${p.str("id")}" else "", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                            Text("Call by ${dayLabel(c.str("due"))} · added by ${c.str("createdBy")}", color = Ui.Muted, fontSize = 12.sp)
                        }
                        if (c.str("status") == "done") Pill("Done", Ui.Green)
                    }
                    Text(c.str("reason"), color = Ui.Text, fontSize = 14.sp)
                    c.objs("notes").takeLast(3).forEach { n -> Text("• ${n.str("text")} (${n.str("by")}, ${whenText(n.optLong("at"))})", color = Ui.Muted, fontSize = 12.sp) }
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Button(onClick = { dial(context, p.str("phone")) }) { Icon(Icons.Filled.Call, null); Text(" Call") }
                        OutlinedButton(onClick = { noteFor = "c:${c.str("id")}" to "note" }) { Text("Add note") }
                        if (c.str("status") != "done") OutlinedButton(onClick = { saveCall(JSONObject().put("id", c.str("id")).put("status", "done")) }) { Text("Done") }
                    }
                }
            }
        }
    }

    noteFor?.let { (key, status) ->
        var note by remember(key, status) { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { noteFor = null },
            title = { Text(if (status == "note") "Add a note" else FOLLOW_STATUS.toMap()[status] ?: status) },
            text = { OutlinedTextField(note, { note = it.take(300) }, label = { Text("Note (optional)") }, modifier = Modifier.fillMaxWidth()) },
            confirmButton = {
                Button(onClick = {
                    val id = key.substring(2)
                    if (key.startsWith("f:")) setFollow(id, status, note) else saveCall(JSONObject().put("id", id).put("note", note))
                    noteFor = null
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { noteFor = null }) { Text("Cancel") } },
        )
    }
    if (adding) AddCallback(vm, session, onDismiss = { adding = false }) { body -> adding = false; saveCall(body) }
}

@Composable
private fun AddCallback(vm: CallViewModel, session: String, onDismiss: () -> Unit, onSave: (JSONObject) -> Unit) {
    var patient by remember { mutableStateOf<JSONObject?>(null) }
    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var due by remember { mutableStateOf(LocalDate.now().toString()) }
    var picking by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add a call-back") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val p = patient
                if (p != null) Text("${p.str("name")} · ${p.str("id")} · ${p.str("phone")}", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                else {
                    OutlinedButton(onClick = { picking = true }, modifier = Modifier.fillMaxWidth()) { Text("Choose a registered patient") }
                    OutlinedTextField(name, { name = it.take(60) }, label = { Text("Or name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(phone, { phone = it.filter(Char::isDigit).take(10) }, label = { Text("Mobile") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.fillMaxWidth())
                }
                OutlinedTextField(reason, { reason = it.take(300) }, label = { Text("Why call (report ready, missed visit…)") }, modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(0L to "Today", 1L to "Tomorrow", 7L to "In a week").forEach { (d, l) -> Choice(l, due == LocalDate.now().plusDays(d).toString()) { due = LocalDate.now().plusDays(d).toString() } }
                }
            }
        },
        confirmButton = {
            Button(enabled = reason.isNotBlank() && (patient != null || (name.isNotBlank() && phone.length == 10)), onClick = {
                val b = JSONObject().put("reason", reason).put("due", due)
                patient?.let { b.put("patientId", it.str("id")) } ?: b.put("patient", JSONObject().put("name", name).put("phone", phone))
                onSave(b)
            }) { Text("Add") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
    if (picking) PatientPicker(vm, session, onDismiss = { picking = false }, onPick = { patient = it; picking = false })
}

// ---------------- Admin: plan ----------------

@Composable
fun PlanScreen(vm: CallViewModel, onBack: () -> Unit) {
    val session = vm.prefs.session("admin") ?: run { LaunchedEffect(Unit) { onBack() }; return }
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var data by remember { mutableStateOf<JSONObject?>(null) }
    var tier by remember { mutableStateOf("") }
    val addons = remember { mutableStateListOf<String>() }
    var expires by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(tick) {
        try {
            val d = api.call("/api/plan", JSONObject().put("session", session)); data = d
            val pl = d.getJSONObject("plan"); tier = pl.str("tier"); addons.clear(); addons.addAll(pl.strs("addons")); expires = pl.str("expires")
            vm.prefs.planJson = pl.toString()
        } catch (e: Exception) { err = e.message }
    }
    Column(Modifier.fillMaxSize()) {
        TopBar("Plan", onBack)
        val d = data ?: run { Column(Modifier.padding(16.dp)) { if (err != null) ErrorText(err) else CircularProgressIndicator(color = Ui.Teal) }; return@Column }
        val plans = d.getJSONObject("plans"); val names = d.getJSONObject("featureNames"); val usage = d.getJSONObject("usage")
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Text("You are on ${d.getJSONObject("plan").str("name")}: ${usage.optInt("doctors")} doctor logins and ${usage.optInt("staff")} staff logins in use.", color = Ui.Text)
                Text("Price: ₹1,000 per doctor per month plus the plan's hospital fee, plus GST.", color = Ui.Muted, fontSize = 13.sp)
            }
            items(listOf("bronze", "silver", "gold", "platinum")) { k ->
                val p = plans.getJSONObject(k); val sel = tier == k
                val maxD = p.optInt("maxDoctors"); val maxS = p.optInt("maxStaff")
                RowCard(onClick = { tier = k; addons.retainAll { p.getJSONObject("f").optString(it) == "addon" } }) {
                    Column(Modifier.weight(1f)) {
                        Text(p.str("name"), color = Ui.Text, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                        Text("${if (maxD >= 9999) "21+" else if (maxD == 1) "1" else if (k == "silver") "2–4" else "5–20"} doctors · ${if (maxS >= 9999) "unlimited" else maxS.toString()} staff logins · fee ${rupees(p.num("fee"))}/month", color = Ui.Muted, fontSize = 12.sp)
                        val f = p.getJSONObject("f")
                        Text(f.keys().asSequence().filter { f.opt(it) == true }.joinToString(", ") { names.str(it) }, color = Ui.Text, fontSize = 12.sp)
                    }
                    if (sel) Pill("Selected", Ui.Teal)
                }
            }
            item {
                val f = plans.getJSONObject(tier.ifBlank { "platinum" }).getJSONObject("f")
                val opts = f.keys().asSequence().filter { f.optString(it) == "addon" }.toList()
                if (opts.isNotEmpty()) BoxCard {
                    Text("Add-ons for this plan", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                    opts.forEach { a ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(names.str(a), color = Ui.Text, modifier = Modifier.weight(1f))
                            Switch(checked = a in addons, onCheckedChange = { on -> if (on) addons.add(a) else addons.remove(a) })
                        }
                    }
                }
            }
            item {
                OutlinedTextField(expires, { expires = it.take(10) }, label = { Text("Licence valid until (YYYY-MM-DD)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text("Shown on the sign-in page and the web portal.", color = Ui.Muted, fontSize = 12.sp)
            }
            item { ErrorText(err) }
            item {
                Button(onClick = {
                    scope.launch {
                        try {
                            api.call("/api/plan/set", JSONObject().put("session", session).put("tier", tier).put("addons", JSONArray(addons.toList())).put("expires", expires))
                            Toast.makeText(context, "Plan saved", Toast.LENGTH_SHORT).show(); err = null; tick++
                        } catch (e: Exception) { err = e.message }
                    }
                }, modifier = Modifier.fillMaxWidth()) { Text("Save plan") }
                Text("New clinics start on Platinum as a trial so every feature can be tried.", color = Ui.Muted, fontSize = 12.sp)
            }
        }
    }
}

// ---------------- Clinic QR code ----------------

@Composable
fun ClinicQrDialog(vm: CallViewModel, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val url = vm.prefs.serverUrl.trimEnd('/') + "/book"
    val bmp = remember(url) { qrBitmap(url) }
    val clinic = runCatching { JSONObject(vm.prefs.clinicJson).optString("name") }.getOrDefault("").ifBlank { "Rx Clinic" }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Clinic QR code") },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Image(bmp.asImageBitmap(), "QR code", modifier = Modifier.size(240.dp))
                Text("Patients scan this to book an appointment. No app needed.", color = Ui.Muted, fontSize = 13.sp)
                Text(url, color = Ui.Text, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
            }
        },
        confirmButton = {
            Button(onClick = {
                Printer.print(context, "Clinic QR code", page(vm.prefs, "Scan to book an appointment",
                    "<div style='text-align:center;margin-top:20px'><img src='${qrDataUri(url)}' style='width:110mm;height:110mm'><p class=big>${esc(clinic)}</p><p class=sub>${esc(url)}</p><p>Open your phone camera, point it at the code and tap the link.</p></div>", sign = false))
            }) { Text("Print poster") }
        },
        dismissButton = { TextButton(onClick = { shareText(context, "Book an appointment at $clinic: $url") }) { Text("Share link") } },
    )
}

internal val DATE_SHORT: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM")
