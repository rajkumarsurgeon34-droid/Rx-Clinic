@file:OptIn(ExperimentalLayoutApi::class)

package com.shazverse.rxclinic.ui

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.shazverse.rxclinic.Api
import com.shazverse.rxclinic.call.CallViewModel
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Patient form fields shared by self-registration and the reception desk. */
private class PatientForm(start: JSONObject? = null) {
    var name by mutableStateOf(start.str("name"))
    var age by mutableStateOf(start.str("age"))
    var sex by mutableStateOf(start.str("sex"))
    var phone by mutableStateOf(start.str("phone"))
    var aadhaar by mutableStateOf("")
    var address by mutableStateOf(start.str("address"))

    fun json(): JSONObject = JSONObject().put("name", name.trim()).put("age", age).put("sex", sex).put("phone", phone)
        .put("aadhaar", aadhaar).put("address", address.trim())
}

@Composable
private fun PatientFields(f: PatientForm, aadhaarHint: String = "") {
    OutlinedTextField(f.name, { f.name = it.take(60) }, label = { Text("Full name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(f.age, { f.age = it.filter(Char::isDigit).take(3) }, label = { Text("Age") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(0.6f))
        OutlinedTextField(f.phone, { f.phone = it.filter(Char::isDigit).take(10) }, label = { Text("Mobile number") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.weight(1.4f))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("Male", "Female", "Other").forEach { s -> Choice(s, f.sex == s, modifier = Modifier.weight(1f)) { f.sex = s } }
    }
    OutlinedTextField(
        f.aadhaar, { f.aadhaar = it.filter(Char::isDigit).take(12) },
        label = { Text(if (aadhaarHint.isNotBlank()) "Aadhaar (now $aadhaarHint; type to change)" else "Aadhaar number (optional)") }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(f.address, { f.address = it.take(200) }, label = { Text("Address (optional)") }, modifier = Modifier.fillMaxWidth())
    Text("Give a mobile number or an Aadhaar number, or both. Aadhaar is stored masked: only the last 4 digits are kept.", color = Ui.Muted, fontSize = 12.sp)
}

/** The Patient ID card. */
@Composable
internal fun PatientIdCard(p: JSONObject) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Ui.Teal).padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("PATIENT ID", color = Color.White.copy(alpha = 0.75f), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        Text(p.str("id"), color = Color.White, fontSize = 32.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
        Text(p.str("name"), color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        Text(listOf(listOf(p.str("age").let { if (it.isBlank()) "" else "$it y" }, p.str("sex")).filter { it.isNotBlank() }.joinToString(" · "),
            p.str("phone").let { if (it.isBlank()) "" else "Mobile $it" }, p.str("aadhaar").let { if (it.isBlank()) "" else "Aadhaar $it" })
            .filter { it.isNotBlank() }.joinToString("\n"), color = Color.White.copy(alpha = 0.9f), fontSize = 13.sp)
    }
}

// ---------------- Patient: register, sign in, own record ----------------

@Composable
fun PatientAccountScreen(vm: CallViewModel, onBack: () -> Unit) {
    var signedIn by remember { mutableStateOf(vm.prefs.patientSession != null) }
    if (signedIn) PatientRecord(vm, onBack, onSignedOut = { vm.prefs.savePatient(null); signedIn = false })
    else PatientSignIn(vm, onBack, onIn = { signedIn = true })
}

@Composable
private fun PatientSignIn(vm: CallViewModel, onBack: () -> Unit, onIn: () -> Unit) {
    val scope = rememberCoroutineScope()
    var tab by remember { mutableStateOf("signin") }
    var login by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var password2 by remember { mutableStateOf("") }
    val form = remember { PatientForm() }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun done(o: JSONObject) {
        val p = o.getJSONObject("patient")
        vm.prefs.savePatient(o.getString("session"), p.str("id"), p.str("name"))
        onIn()
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar("My Patient ID", onBack)
        Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice("Sign in", tab == "signin", modifier = Modifier.weight(1f)) { tab = "signin"; err = null }
            Choice("New patient", tab == "register", modifier = Modifier.weight(1f)) { tab = "register"; err = null }
        }
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (tab == "signin") {
                OutlinedTextField(login, { login = it.take(20) }, label = { Text("Patient ID, mobile or Aadhaar") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                PasswordField(password, { password = it }, "Password")
                ErrorText(err)
                Button(enabled = !busy && login.isNotBlank() && password.isNotBlank(), modifier = Modifier.fillMaxWidth().height(50.dp), onClick = {
                    busy = true; err = null
                    scope.launch {
                        try { done(Api(vm.prefs.serverUrl).call("/api/patient/login", JSONObject().put("login", login).put("password", password))) }
                        catch (e: Exception) { err = e.message }
                        busy = false
                    }
                }) { Text(if (busy) "Signing in…" else "Sign in") }
                Text("Registered at the clinic desk but no password yet? Ask the reception to set one for you.", color = Ui.Muted, fontSize = 12.sp)
            } else {
                Text("Register once and get your Patient ID. Use it at every visit so the doctor sees your past prescriptions and reports.", color = Ui.Muted, fontSize = 13.sp)
                PatientFields(form)
                PasswordField(password, { password = it }, "Choose a password (at least 6)")
                PasswordField(password2, { password2 = it }, "Password again")
                ErrorText(err)
                Button(
                    enabled = !busy && form.name.isNotBlank() && (form.phone.length == 10 || form.aadhaar.length == 12) && password.length >= 6,
                    modifier = Modifier.fillMaxWidth().height(50.dp),
                    onClick = {
                        if (password != password2) { err = "The two passwords don't match"; return@Button }
                        busy = true; err = null
                        scope.launch {
                            try { done(Api(vm.prefs.serverUrl).call("/api/patient/register", form.json().put("password", password))) }
                            catch (e: Exception) { err = e.message }
                            busy = false
                        }
                    },
                ) { Text(if (busy) "Registering…" else "Register and get my Patient ID") }
            }
        }
    }
}

@Composable
private fun PatientRecord(vm: CallViewModel, onBack: () -> Unit, onSignedOut: () -> Unit) {
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var data by remember { mutableStateOf<JSONObject?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    var editing by remember { mutableStateOf(false) }
    var changingPw by remember { mutableStateOf(false) }

    LaunchedEffect(refresh) {
        try { data = api.call("/api/patient/me", JSONObject().put("session", vm.prefs.patientSession.orEmpty())) }
        catch (e: Exception) { if (e.message?.contains("Sign in", true) == true) onSignedOut() else err = e.message }
    }

    Column(Modifier.fillMaxSize()) {
        TopBar("My Patient ID", onBack) { TextButton(onClick = onSignedOut) { Text("Sign out") } }
        val d = data
        if (d == null) { Column(Modifier.padding(16.dp)) { if (err != null) ErrorText(err) else CircularProgressIndicator(color = Ui.Teal) }; return@Column }
        val p = d.getJSONObject("patient")
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { PatientIdCard(p) }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { editing = true }) { Text("Edit details") }
                    OutlinedButton(onClick = { changingPw = true }) { Text("Change password") }
                }
                Text("Show this Patient ID at the clinic desk, or type it when you check in.", color = Ui.Muted, fontSize = 13.sp)
            }
            val appts = d.objs("appointments")
            if (appts.isNotEmpty()) {
                item { Text("Appointments", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, fontFamily = FontFamily.Serif) }
                items(appts, key = { "a" + it.str("id") }) { a ->
                    RowCard {
                        Column(Modifier.weight(1f)) {
                            Text("${dayLabel(a.str("date"))} · ${time12(a.str("time"))}", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                            Text((if (a.str("mode") == "tele") "Video teleconsult" else "Clinic visit") + " · code ${a.str("code")}", color = Ui.Muted, fontSize = 13.sp)
                        }
                        Pill(statusLabel(a.str("status")), statusColor(a.str("status")))
                    }
                }
            }
            val bills = d.objs("bills")
            if (bills.isNotEmpty()) {
                item { Text("My bills", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, fontFamily = FontFamily.Serif) }
                items(bills, key = { "b" + it.str("id") }) { b ->
                    RowCard {
                        Column(Modifier.weight(1f)) {
                            Text("${b.str("deptName")} · ${b.str("no")}", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                            Text(dayLabel(b.str("date")) + " · " + b.objs("items").joinToString(", ") { it.str("desc") }, color = Ui.Muted, fontSize = 12.sp, maxLines = 2)
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text(rupees(b.num("total")), color = Ui.Text, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold)
                            Pill(billStatusLabel(b.str("status")), billStatusColor(b.str("status")))
                        }
                    }
                }
            }
            item { Text("My visits, prescriptions and reports", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, fontFamily = FontFamily.Serif) }
            val visits = d.objs("visits")
            if (visits.isEmpty()) item { Text("No visits yet.", color = Ui.Muted) }
            items(visits, key = { "v" + it.str("id") }) { h -> BoxCard { VisitSummaryCard(h) } }
        }
        if (editing) EditOwnDetailsDialog(p, onDismiss = { editing = false }, onSave = { f ->
            scope.launch {
                try {
                    val body = f.json().put("session", vm.prefs.patientSession.orEmpty())
                    if (f.aadhaar.isBlank()) body.remove("aadhaar")
                    api.call("/api/patient/update", body)
                    editing = false; refresh++
                    Toast.makeText(context, "Details saved", Toast.LENGTH_SHORT).show()
                } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't save", Toast.LENGTH_LONG).show() }
            }
        })
    }
    if (changingPw) ChangePasswordDialog(vm, patient = true, onDone = { changingPw = false })
}

@Composable
private fun EditPatientDialog(p: JSONObject, withPassword: Boolean = false, onDismiss: () -> Unit, onSave: (PatientForm, String) -> Unit) {
    val f = remember(p) { PatientForm(p) }
    var pw by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (p.str("id").isBlank()) "Register patient" else "Edit · ${p.str("id")}") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PatientFields(f, p.str("aadhaar"))
                if (withPassword) PasswordField(pw, { pw = it }, if (p.optBoolean("hasLogin")) "New app password (leave empty to keep)" else "App password for the patient (optional)")
            }
        },
        confirmButton = { Button(enabled = f.name.isNotBlank(), onClick = { onSave(f, pw) }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun EditOwnDetailsDialog(p: JSONObject, onDismiss: () -> Unit, onSave: (PatientForm) -> Unit) =
    EditPatientDialog(p, false, onDismiss) { f, _ -> onSave(f) }

// ---------------- Staff: patient registry (reception, nurses, doctors, admin) ----------------

@Composable
fun PatientRegistryScreen(vm: CallViewModel, onBack: () -> Unit, onSignedOut: () -> Unit) {
    val session = vm.prefs.sessionFor("staff") ?: vm.prefs.sessionFor("doctor") ?: vm.prefs.sessionFor("billing") ?: run { LaunchedEffect(Unit) { onSignedOut() }; return }
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var q by remember { mutableStateOf("") }
    val results = remember { mutableStateListOf<JSONObject>() }
    var searching by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    var registering by remember { mutableStateOf(false) }
    var open by remember { mutableStateOf<JSONObject?>(null) } // { patient, visits }
    var editing by remember { mutableStateOf<JSONObject?>(null) }

    fun search() = scope.launch {
        searching = true; err = null
        try {
            val r = api.call("/api/patients/search", JSONObject().put("session", session).put("q", q)).objs("patients")
            results.clear(); results.addAll(r)
            if (r.isEmpty()) err = "No patient found. Check the number, or register them."
        } catch (e: Exception) { err = e.message }
        searching = false
    }
    fun openPatient(id: String) = scope.launch {
        try { open = api.call("/api/patients/get", JSONObject().put("session", session).put("id", id)) }
        catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't open", Toast.LENGTH_LONG).show() }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar("Patient records", onBack) { Button(onClick = { registering = true }) { Text("Register") } }
        Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(q, { q = it.take(40) }, label = { Text("Patient ID, mobile, Aadhaar or name") }, singleLine = true, modifier = Modifier.weight(1f))
            Button(enabled = q.trim().length >= 2 && !searching, onClick = { search() }) { Text("Find") }
        }
        Column(Modifier.padding(horizontal = 16.dp)) { ErrorText(err) }
        val o = open
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (o != null) {
                val p = o.getJSONObject("patient")
                item { PatientIdCard(p) }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { editing = p }) { Text("Edit / set password") }
                        TextButton(onClick = { open = null }) { Text("Close") }
                    }
                    Text(if (p.optBoolean("hasLogin")) "Has an app password." else "No app password yet: set one so the patient can sign in.", color = Ui.Muted, fontSize = 13.sp)
                }
                item { Text("Visits (${o.objs("visits").size})", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 17.sp) }
                items(o.objs("visits"), key = { "v" + it.str("id") }) { h -> BoxCard { VisitSummaryCard(h) } }
            } else {
                items(results, key = { it.str("id") }) { p ->
                    RowCard(onClick = { openPatient(p.str("id")) }) {
                        Text(p.str("id"), color = Ui.Teal, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                        Column(Modifier.weight(1f)) {
                            Text(p.str("name"), color = Ui.Text, fontWeight = FontWeight.SemiBold)
                            Text(listOf("${p.str("age")} ${p.str("sex")}".trim(), p.str("phone"), p.str("aadhaar")).filter { it.isNotBlank() }.joinToString(" · "), color = Ui.Muted, fontSize = 13.sp)
                        }
                    }
                }
            }
        }
    }

    if (registering) EditPatientDialog(JSONObject(), withPassword = true, onDismiss = { registering = false }, onSave = { f, pw ->
        scope.launch {
            try {
                val body = f.json().put("session", session)
                if (pw.isNotBlank()) body.put("password", pw)
                val p = api.call("/api/patients/register", body).getJSONObject("patient")
                registering = false
                Toast.makeText(context, "Registered: Patient ID ${p.str("id")}", Toast.LENGTH_LONG).show()
                openPatient(p.str("id"))
            } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't register", Toast.LENGTH_LONG).show() }
        }
    })
    editing?.let { p ->
        EditPatientDialog(p, withPassword = true, onDismiss = { editing = null }, onSave = { f, pw ->
            scope.launch {
                try {
                    val x = f.json(); if (f.aadhaar.isBlank()) x.remove("aadhaar"); if (pw.isNotBlank()) x.put("password", pw)
                    api.call("/api/patients/update", JSONObject().put("session", session).put("id", p.str("id")).put("patient", x))
                    editing = null; openPatient(p.str("id"))
                    Toast.makeText(context, "Saved", Toast.LENGTH_SHORT).show()
                } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't save", Toast.LENGTH_LONG).show() }
            }
        })
    }
}
