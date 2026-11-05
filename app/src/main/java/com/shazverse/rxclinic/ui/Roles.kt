@file:OptIn(ExperimentalLayoutApi::class)

package com.shazverse.rxclinic.ui

import android.widget.Toast
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Biotech
import androidx.compose.material.icons.filled.LocalHospital
import androidx.compose.material.icons.filled.LocalPharmacy
import androidx.compose.material.icons.filled.MedicalServices
import androidx.compose.material.icons.filled.MonitorHeart
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
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
    "admin" to "Admin",
)

private fun signedOutError(e: Exception) = e.message?.contains("Sign in", ignoreCase = true) == true

// ---------------- PIN sign-in, shared by every staff role ----------------

@Composable
fun StaffLogin(vm: CallViewModel, role: String, onBack: () -> Unit, onIn: () -> Unit) {
    val scope = rememberCoroutineScope()
    var pin by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val title = ROLE_TITLES[role] ?: role
    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar("$title sign-in", onBack)
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Enter the ${title.lowercase()} PIN.", color = Ui.Muted)
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
                            val s = Api(vm.prefs.serverUrl).login(role, pin)
                            vm.prefs.saveSession(role, s.token)
                            if (role == "doctor" || role == "admin") vm.prefs.doctorName = s.doctorName
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
private fun SignOutButton(vm: CallViewModel, role: String, onSignedOut: () -> Unit) {
    TextButton(onClick = { vm.prefs.saveSession(role, null); onSignedOut() }) { Text("Sign out") }
}

// ---------------- Nursing staff: OPD triage vitals ----------------

@Composable
fun NurseScreen(vm: CallViewModel, onBack: () -> Unit, onSignedOut: () -> Unit) {
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
        catch (e: Exception) { if (signedOutError(e)) { vm.prefs.saveSession("staff", null); onSignedOut() } else err = e.message }
        loading = false
    }

    Column(Modifier.fillMaxSize()) {
        TopBar("Nursing · Triage", onBack) {
            IconButton(onClick = { refresh++ }) { Icon(Icons.Filled.Refresh, "Refresh", tint = Ui.Text) }
            SignOutButton(vm, "staff", onSignedOut)
        }
        Text("Today's checked-in patients. Record vitals before they see the doctor; they appear on the doctor's case sheet.",
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
                }
            },
            confirmButton = {
                Button(onClick = {
                    scope.launch {
                        try {
                            val vo = JSONObject(); vals.forEach { (k, x) -> vo.put(k, x) }
                            api.call("/api/nurse/vitals", JSONObject().put("session", session).put("id", v.str("id")).put("vitals", vo).put("note", note))
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
fun PharmacyScreen(vm: CallViewModel, onBack: () -> Unit, onSignedOut: () -> Unit) {
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

    LaunchedEffect(refresh) {
        loading = true; err = null
        try {
            val q = api.call("/api/pharmacy/queue", JSONObject().put("session", session)).objs("queue")
            val s = api.call("/api/pharmacy/stock", JSONObject().put("session", session)).objs("stock")
            queue.clear(); queue.addAll(q); stock.clear(); stock.addAll(s)
        } catch (e: Exception) { if (signedOutError(e)) { vm.prefs.saveSession("pharmacy", null); onSignedOut() } else err = e.message }
        loading = false
    }

    fun inStock(name: String): Boolean {
        val n = name.lowercase()
        return stock.any { val g = it.str("generic").lowercase(); g.length >= 4 && it.optInt("stock") > 0 && (n.contains(g) || g.contains(n)) }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar("Pharmacy", onBack) {
            IconButton(onClick = { refresh++ }) { Icon(Icons.Filled.Refresh, "Refresh", tint = Ui.Text) }
            SignOutButton(vm, "pharmacy", onSignedOut)
        }
        Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice("To dispense (${queue.count { it.str("status") == "sent" }})", tab == "dispense", modifier = Modifier.weight(1f)) { tab = "dispense" }
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
                        if (v.str("status") == "sent") Button(onClick = {
                            scope.launch {
                                try {
                                    api.call("/api/pharmacy/dispense", JSONObject().put("session", session).put("id", v.str("id")))
                                    Toast.makeText(context, "Marked dispensed", Toast.LENGTH_SHORT).show(); refresh++
                                } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't update", Toast.LENGTH_LONG).show() }
                            }
                        }, modifier = Modifier.fillMaxWidth()) { Text("Mark dispensed") }
                    }
                }
            }
        } else {
            var generic by remember { mutableStateOf("") }
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
                        }
                        Button(enabled = generic.isNotBlank(), onClick = {
                            scope.launch {
                                try {
                                    api.call("/api/pharmacy/stock/save", JSONObject().put("session", session).put("item",
                                        JSONObject().put("generic", generic.trim()).put("brand", brand.trim()).put("form", form.trim()).put("strength", strength.trim()).put("stock", units.toIntOrNull() ?: 0)))
                                    generic = ""; brand = ""; strength = ""; units = ""; refresh++
                                } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't add", Toast.LENGTH_LONG).show() }
                            }
                        }) { Text("Add to stock") }
                        Text("Or paste a list (one per line: generic, brand, form, strength, units). You can copy columns from Excel.", color = Ui.Muted, fontSize = 12.sp)
                        OutlinedTextField(bulk, { bulk = it }, label = { Text("Paste list") }, minLines = 2, modifier = Modifier.fillMaxWidth())
                        OutlinedButton(enabled = bulk.isNotBlank(), onClick = {
                            val arr = JSONArray()
                            bulk.lines().map { l -> l.split('\t', ',').map { it.trim() } }.filter { it.firstOrNull().orEmpty().isNotBlank() }.forEach { c ->
                                arr.put(JSONObject().put("generic", c[0]).put("brand", c.getOrElse(1) { "" }).put("form", c.getOrElse(2) { "Tab" })
                                    .put("strength", c.getOrElse(3) { "" }).put("stock", c.getOrElse(4) { "0" }.toIntOrNull() ?: 0))
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
                    StockRow(d, onSave = { n ->
                        scope.launch {
                            try { api.call("/api/pharmacy/stock/save", JSONObject().put("session", session).put("item", JSONObject(d.toString()).put("stock", n))); refresh++ }
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
}

@Composable
private fun StockRow(d: JSONObject, onSave: (Int) -> Unit, onDelete: () -> Unit) {
    var units by remember(d.str("id"), d.optInt("stock")) { mutableStateOf(d.optInt("stock").toString()) }
    RowCard {
        Column(Modifier.weight(1f)) {
            Text("${d.str("generic")} ${d.str("strength")}", color = Ui.Text, fontWeight = FontWeight.SemiBold)
            Text(listOf(d.str("form"), d.str("brand")).filter { it.isNotBlank() }.joinToString(" · "), color = Ui.Muted, fontSize = 13.sp)
        }
        OutlinedTextField(units, { units = it.filter(Char::isDigit).take(6) }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.width(84.dp))
        TextButton(onClick = { onSave(units.toIntOrNull() ?: 0) }) { Text("Save") }
        TextButton(onClick = onDelete) { Text("Delete", color = Ui.Red) }
    }
}

// ---------------- Lab, and Diagnostics (USG, CT, MRI, PET-CT, X-ray) ----------------

@Composable
fun OrdersScreen(vm: CallViewModel, role: String, onBack: () -> Unit, onSignedOut: () -> Unit) {
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

    LaunchedEffect(refresh) {
        loading = true; err = null
        try {
            val o = api.call("/api/orders/list", JSONObject().put("session", session).put("kind", if (imaging) "imaging" else "lab")).objs("orders")
            list.clear(); list.addAll(o)
        } catch (e: Exception) { if (signedOutError(e)) { vm.prefs.saveSession(role, null); onSignedOut() } else err = e.message }
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
            SignOutButton(vm, role, onSignedOut)
        }
        Text(if (imaging) "Scan orders from the doctors. Schedule the scan, then enter findings and impression; the report reaches the doctor's case sheet."
            else "Test orders from the doctors. Mark the sample collected, then enter the report; it reaches the doctor's case sheet.",
            color = Ui.Muted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp))
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
    val pins = remember { mutableStateMapOf<String, String>() }
    val clinic = remember { mutableStateMapOf<String, String>() }

    LaunchedEffect(refresh) {
        err = null
        try {
            ov = api.call("/api/admin/overview", JSONObject().put("session", session))
            val st = api.call("/api/settings", JSONObject().put("session", session))
            st.obj("pins")?.let { p -> p.keys().forEach { k -> pins[k] = p.str(k) } }
            st.obj("clinic")?.let { c -> c.keys().forEach { k -> clinic[k] = c.str(k) } }
        } catch (e: Exception) { if (signedOutError(e)) { vm.prefs.saveSession("admin", null); onSignedOut() } else err = e.message }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar("Admin", onBack) {
            IconButton(onClick = { refresh++ }) { Icon(Icons.Filled.Refresh, "Refresh", tint = Ui.Text) }
            SignOutButton(vm, "admin", onSignedOut)
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
                }
            }
            item {
                Text("Open a section", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, fontFamily = FontFamily.Serif)
                Text("As admin you can open every section without its PIN.", color = Ui.Muted, fontSize = 13.sp)
            }
            item { RoleCard("Doctor", "OPD, case sheets, appointments, video", Icons.Filled.MedicalServices) { onOpen("doctor") } }
            item { RoleCard("Nursing staff", "Triage vitals", Icons.Filled.LocalHospital) { onOpen("staff") } }
            item { RoleCard("Pharmacy", "Dispensing and stock", Icons.Filled.LocalPharmacy) { onOpen("pharmacy") } }
            item { RoleCard("Lab", "Test orders and reports", Icons.Filled.Biotech) { onOpen("lab") } }
            item { RoleCard("Diagnostics", "USG, CT, MRI, PET-CT, X-ray", Icons.Filled.MonitorHeart) { onOpen("diagnostics") } }
            item {
                BoxCard {
                    Text("Sign-in PINs", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
                    Text("4 to 8 digits each. Change the defaults before real use.", color = Ui.Muted, fontSize = 13.sp)
                    ROLE_TITLES.forEach { (k, t) ->
                        OutlinedTextField(pins[k].orEmpty(), { pins[k] = it.filter(Char::isDigit).take(8) }, label = { Text(t) }, singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
                    }
                    Button(onClick = {
                        scope.launch {
                            try {
                                val p = JSONObject(); pins.forEach { (k, x) -> p.put(k, x) }
                                api.call("/api/settings", JSONObject().put("session", session).put("pins", p))
                                Toast.makeText(context, "PINs saved", Toast.LENGTH_SHORT).show()
                            } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't save", Toast.LENGTH_LONG).show() }
                        }
                    }) { Text("Save PINs") }
                }
            }
            item {
                BoxCard {
                    Text("Clinic details (prescription letterhead)", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
                    listOf("name" to "Clinic name", "doctor" to "Doctor", "qual" to "Qualification", "reg" to "Registration number", "phone" to "Phone", "hours" to "OPD hours", "address" to "Address").forEach { (k, l) ->
                        OutlinedTextField(clinic[k].orEmpty(), { clinic[k] = it.take(200) }, label = { Text(l) }, singleLine = k != "address", modifier = Modifier.fillMaxWidth())
                    }
                    Button(onClick = {
                        scope.launch {
                            try {
                                val c = JSONObject(); clinic.forEach { (k, x) -> c.put(k, x) }
                                api.call("/api/settings", JSONObject().put("session", session).put("clinic", c))
                                vm.prefs.doctorName = clinic["doctor"].orEmpty()
                                Toast.makeText(context, "Clinic details saved", Toast.LENGTH_SHORT).show()
                            } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't save", Toast.LENGTH_LONG).show() }
                        }
                    }) { Text("Save clinic details") }
                }
            }
        }
    }
}

// ---------------- small shared pieces ----------------

@Composable
private fun Stat(label: String, value: String, sub: String) {
    Column(
        Modifier.width(150.dp).clip(RoundedCornerShape(14.dp)).background(Ui.Card).border(1.dp, Ui.Line, RoundedCornerShape(14.dp)).padding(12.dp),
    ) {
        Text(label.uppercase(), color = Ui.Muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        Text(value.ifBlank { "0" }, color = Ui.Text, fontSize = 28.sp, fontFamily = FontFamily.Monospace)
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
