@file:OptIn(ExperimentalLayoutApi::class)

package com.shazverse.rxclinic.ui

import android.widget.Toast
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.shazverse.rxclinic.Api
import com.shazverse.rxclinic.call.CallViewModel
import com.shazverse.rxclinic.call.shareText
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// ---------------- helpers ----------------

private val INR = NumberFormat.getNumberInstance(Locale("en", "IN")).apply { minimumFractionDigits = 0; maximumFractionDigits = 2 }
internal fun rupees(x: Double) = "₹" + INR.format(x)
internal fun JSONObject?.num(k: String): Double = this?.optDouble(k, 0.0)?.takeIf { !it.isNaN() } ?: 0.0

val PAY_MODES = listOf("Cash", "UPI", "Card", "Insurance")
val DEPT_TITLES = linkedMapOf("opd" to "OPD", "pharmacy" to "Pharmacy", "lab" to "Lab", "diagnostics" to "Diagnostics", "ip" to "Inpatient")

internal fun billStatusLabel(s: String) = when (s) {
    "paid" -> "Paid"; "partial" -> "Part paid"; "unpaid" -> "Unpaid"; "cancelled" -> "Cancelled"
    "to-ip" -> "On IP account"; "on-ip-bill" -> "On IP bill"; else -> s
}
internal fun billStatusColor(s: String) = when (s) {
    "paid" -> Ui.Green; "partial", "unpaid" -> Ui.Amber; "cancelled" -> Ui.Muted; else -> Ui.Ai
}

private val TIME_FMT = DateTimeFormatter.ofPattern("d MMM yyyy, h:mm a", Locale.ENGLISH)
internal fun whenText(ms: Long) = if (ms <= 0) "" else Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).format(TIME_FMT)

/** Plain-text bill for WhatsApp, SMS or print apps. */
internal fun billText(b: JSONObject, clinic: String): String = buildString {
    val p = b.obj("patient")
    append("${clinic.ifBlank { "Rx Clinic" }}\n${b.str("deptName")} bill ${b.str("no")}\n${whenText(b.optLong("created"))}\n\n")
    append("Patient: ${p.str("name")}")
    if (p.str("id").isNotBlank()) append("  (ID ${p.str("id")})")
    append("\n")
    if (b.str("admissionNo").isNotBlank()) append("Admission ${b.str("admissionNo")}: ${whenText(b.optLong("admittedAt"))} to ${whenText(b.optLong("dischargedAt"))}\n")
    append("\n")
    b.objs("items").forEachIndexed { i, it ->
        val q = it.num("qty"); val qs = if (q % 1.0 == 0.0) q.toLong().toString() else q.toString()
        append("${i + 1}. ${it.str("desc")}  $qs × ${rupees(it.num("rate"))} = ${rupees(it.num("amount"))}\n")
    }
    append("\nSubtotal: ${rupees(b.num("subtotal"))}\n")
    if (b.num("discount") > 0) append("Discount: −${rupees(b.num("discount"))}\n")
    append("TOTAL: ${rupees(b.num("total"))}\n")
    b.objs("payments").forEach { append("Paid ${it.str("mode")}${if (it.str("ref").isNotBlank()) " (${it.str("ref")})" else ""}: ${rupees(it.num("amount"))}\n") }
    val bal = b.num("balance")
    if (bal > 0.004) append("Balance due: ${rupees(bal)}\n") else if (bal < -0.004) append("Refund due: ${rupees(-bal)}\n")
    append("Status: ${billStatusLabel(b.str("status"))}\n")
}

private class Line(desc: String = "", qty: String = "1", rate: String = "", val ref: String = "", val unit: String = "", val note: String = "") {
    var desc by mutableStateOf(desc)
    var qty by mutableStateOf(qty)
    var rate by mutableStateOf(rate)
    val amount get() = (qty.toDoubleOrNull() ?: 0.0) * (rate.toDoubleOrNull() ?: 0.0)
    fun json(): JSONObject = JSONObject().put("desc", desc.trim()).put("qty", qty.toDoubleOrNull() ?: 0.0).put("rate", rate.toDoubleOrNull() ?: 0.0).put("ref", ref).put("unit", unit)
}
private fun numText(x: Double) = if (x % 1.0 == 0.0) x.toLong().toString() else x.toString()

// ---------------- patient picker ----------------

@Composable
internal fun PatientPicker(vm: CallViewModel, session: String, title: String = "Choose patient", onDismiss: () -> Unit, onPick: (JSONObject) -> Unit) {
    val scope = rememberCoroutineScope()
    var q by remember { mutableStateOf("") }
    val list = remember { mutableStateListOf<JSONObject>() }
    var err by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedTextField(q, { q = it.take(40) }, label = { Text("Patient ID, mobile, Aadhaar or name") }, singleLine = true, modifier = Modifier.weight(1f))
                    Button(enabled = q.trim().length >= 2, onClick = {
                        scope.launch {
                            err = null
                            try {
                                val r = Api(vm.prefs.serverUrl).call("/api/patients/search", JSONObject().put("session", session).put("q", q)).objs("patients")
                                list.clear(); list.addAll(r); if (r.isEmpty()) err = "No patient found. Register them in Patient records."
                            } catch (e: Exception) { err = e.message }
                        }
                    }) { Text("Find") }
                }
                ErrorText(err)
                Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    list.forEach { p ->
                        RowCard(onClick = { onPick(p) }) {
                            Text(p.str("id"), color = Ui.Teal, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                            Column(Modifier.weight(1f)) {
                                Text(p.str("name"), color = Ui.Text, fontWeight = FontWeight.SemiBold)
                                Text(listOf("${p.str("age")} ${p.str("sex")}".trim(), p.str("phone")).filter { it.isNotBlank() }.joinToString(" · "), color = Ui.Muted, fontSize = 12.sp)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// ---------------- bill editor ----------------

/**
 * Makes a bill. Pre-fills from the visit (medicines for pharmacy, unbilled tests for lab/diagnostics,
 * registration/consultation for OPD). [onSaved] gets the saved bill.
 */
@Composable
fun BillEditor(
    vm: CallViewModel, session: String, dept: String, visitId: String = "", patientId: String = "", dispense: Boolean = false,
    onDismiss: () -> Unit, onSaved: (JSONObject) -> Unit,
) {
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    val lines = remember { mutableStateListOf<Line>() }
    var patient by remember { mutableStateOf(JSONObject()) }
    var walkInName by remember { mutableStateOf("") }
    var orderIds by remember { mutableStateOf(JSONArray()) }
    var admission by remember { mutableStateOf<JSONObject?>(null) }
    var toIp by remember { mutableStateOf(false) }
    var discount by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf("Cash") }
    var received by remember { mutableStateOf<String?>(null) } // null = full amount
    var payRef by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf(false) }
    var choosePatient by remember { mutableStateOf(false) }
    val catalog = remember { mutableStateListOf<JSONObject>() } // stock (pharmacy) or price list
    var search by remember { mutableStateOf("") }

    suspend fun loadDraft(pid: String) {
        val d = api.call("/api/bills/draft", JSONObject().put("session", session).put("dept", dept).put("visitId", visitId).put("patientId", pid))
        patient = d.optJSONObject("patient") ?: JSONObject()
        orderIds = d.optJSONArray("orderIds") ?: JSONArray()
        admission = d.optJSONObject("admission")
        if (lines.isEmpty()) d.objs("items").forEach { i ->
            lines.add(Line(i.str("desc"), numText(i.num("qty")), numText(i.num("rate")), i.str("ref"), i.str("unit"),
                if (dept == "pharmacy") (if (i.str("ref").isBlank()) "Not in stock list" else "In stock: ${i.optInt("inStock")}") else if (i.num("rate") == 0.0) "Not in price list: enter the rate" else ""))
        }
    }

    LaunchedEffect(Unit) {
        try {
            loadDraft(patientId)
            val c = if (dept == "pharmacy") api.call("/api/pharmacy/stock", JSONObject().put("session", session)).objs("stock")
            else api.call("/api/tariff/list", JSONObject().put("session", session).put("dept", dept)).objs("tariff")
            catalog.clear(); catalog.addAll(c)
        } catch (e: Exception) { err = e.message }
        loading = false
    }

    val subtotal = lines.sumOf { it.amount }
    val disc = (discount.toDoubleOrNull() ?: 0.0).coerceIn(0.0, subtotal)
    val total = subtotal - disc
    val name = patient.str("name").ifBlank { walkInName }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(Ui.Bg).imePadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, "Close", tint = Ui.Text) }
                Text("New ${DEPT_TITLES[dept] ?: ""} bill", color = Ui.Text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Serif, modifier = Modifier.weight(1f))
            }
            if (loading) { Box(Modifier.padding(16.dp)) { CircularProgressIndicator(color = Ui.Teal) }; return@Column }
            LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                item {
                    BoxCard {
                        if (patient.str("name").isNotBlank()) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(patient.str("name"), color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                                    Text(listOf(patient.str("id"), "${patient.str("age")} ${patient.str("sex")}".trim(), patient.str("phone")).filter { it.isNotBlank() }.joinToString(" · "), color = Ui.Muted, fontSize = 13.sp)
                                }
                                if (visitId.isBlank()) TextButton(onClick = { choosePatient = true }) { Text("Change") }
                            }
                        } else {
                            Text("Patient", color = Ui.Muted, fontSize = 13.sp)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedTextField(walkInName, { walkInName = it.take(60) }, label = { Text("Name (walk-in)") }, singleLine = true, modifier = Modifier.weight(1f))
                                OutlinedButton(onClick = { choosePatient = true }) { Text("Find ID") }
                            }
                        }
                        admission?.let { a ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text("Admitted: ${a.str("no")} · ${a.str("ward")} ${a.str("bed")}", color = Ui.Ai, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                                    Text("Add to the inpatient bill instead of paying now", color = Ui.Muted, fontSize = 12.sp)
                                }
                                Switch(checked = toIp, onCheckedChange = { toIp = it })
                            }
                        }
                    }
                }
                item { Text("Items", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 17.sp) }
                if (lines.isEmpty()) item { Text("No items yet. Add from the list below.", color = Ui.Muted) }
                items(lines.size) { i ->
                    val l = lines[i]
                    BoxCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            OutlinedTextField(l.desc, { l.desc = it.take(160) }, singleLine = true, modifier = Modifier.weight(1f), textStyle = androidx.compose.ui.text.TextStyle(fontSize = 14.sp))
                            IconButton(onClick = { lines.removeAt(i) }) { Icon(Icons.Filled.Close, "Remove", tint = Ui.Red) }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(l.qty, { l.qty = it.filter { c -> c.isDigit() || c == '.' }.take(7) }, label = { Text(if (l.unit == "per day") "Days" else "Qty") }, singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.width(84.dp))
                            OutlinedTextField(l.rate, { l.rate = it.filter { c -> c.isDigit() || c == '.' }.take(9) }, label = { Text("Rate ₹") }, singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.width(110.dp))
                            Text(rupees(l.amount), color = Ui.Text, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                        }
                        if (l.note.isNotBlank()) Text(l.note, color = if (l.note.startsWith("In stock")) Ui.Muted else Ui.Amber, fontSize = 12.sp)
                    }
                }
                item {
                    BoxCard {
                        Text(if (dept == "pharmacy") "Add a medicine" else "Add from the price list", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                        OutlinedTextField(search, { search = it.take(40) }, label = { Text("Search") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        val found = catalog.filter { c -> val n = if (dept == "pharmacy") c.str("generic") + " " + c.str("brand") else c.str("name"); search.isBlank() || n.contains(search.trim(), true) }.take(if (search.isBlank()) 8 else 20)
                        found.forEach { c ->
                            val label = if (dept == "pharmacy") listOf(c.str("form"), c.str("generic"), c.str("strength")).filter { it.isNotBlank() }.joinToString(" ") else c.str("name")
                            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable {
                                lines.add(Line(label, "1", numText(c.num("price")), if (dept == "pharmacy") c.str("id") else "", c.str("unit"),
                                    if (dept == "pharmacy") "In stock: ${c.optInt("stock")}" else ""))
                                search = ""
                            }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("+ $label", color = Ui.Teal, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(rupees(c.num("price")) + if (c.str("unit") == "per day") "/day" else "", color = Ui.Muted, fontSize = 13.sp)
                            }
                        }
                        TextButton(onClick = { lines.add(Line(search.trim(), "1", "")); search = "" }) { Text("+ Other item (type the name and rate)") }
                    }
                }
                item {
                    BoxCard {
                        TotalRow("Subtotal", subtotal)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Discount ₹", color = Ui.Text, modifier = Modifier.weight(1f))
                            OutlinedTextField(discount, { discount = it.filter { c -> c.isDigit() || c == '.' }.take(9) }, singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.width(120.dp))
                        }
                        HorizontalDivider(color = Ui.Line)
                        TotalRow("Total", total, big = true)
                    }
                }
                if (!toIp) item {
                    BoxCard {
                        Text("Payment received", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { PAY_MODES.forEach { m -> Choice(m, mode == m, modifier = Modifier.weight(1f)) { mode = m } } }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(received ?: numText(total), { received = it.filter { c -> c.isDigit() || c == '.' }.take(9) }, label = { Text("Amount ₹") }, singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f))
                            if (mode != "Cash") OutlinedTextField(payRef, { payRef = it.take(60) }, label = { Text(if (mode == "Insurance") "Claim / TPA" else "Ref no.") }, singleLine = true, modifier = Modifier.weight(1f))
                        }
                        Text("Leave 0 to bill now and collect later.", color = Ui.Muted, fontSize = 12.sp)
                    }
                }
                item { ErrorText(err) }
            }
            Row(Modifier.fillMaxWidth().background(Ui.Card).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Total", color = Ui.Muted, fontSize = 12.sp)
                    Text(rupees(total), color = Ui.Text, fontSize = 22.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                }
                Button(enabled = !busy && lines.isNotEmpty() && name.isNotBlank(), modifier = Modifier.height(50.dp), onClick = {
                    busy = true; err = null
                    scope.launch {
                        try {
                            val p = if (patient.str("name").isNotBlank()) patient else JSONObject().put("name", walkInName.trim())
                            val bill = JSONObject().put("dept", dept).put("patient", p).put("visitId", visitId).put("discount", disc).put("toIp", toIp)
                                .put("orderIds", orderIds).put("items", JSONArray().apply { lines.forEach { put(it.json()) } })
                            val body = JSONObject().put("session", session).put("bill", bill).put("dispense", dispense)
                            val amt = (received ?: numText(total)).toDoubleOrNull() ?: 0.0
                            if (!toIp && amt > 0) body.put("pay", JSONObject().put("mode", mode).put("amount", amt).put("ref", payRef))
                            onSaved(api.call("/api/bills/save", body).getJSONObject("bill"))
                        } catch (e: Exception) { err = e.message }
                        busy = false
                    }
                }) { Text(if (busy) "Saving…" else if (toIp) "Add to IP bill" else if (dispense) "Save bill & dispense" else "Save bill") }
            }
        }
    }
    if (choosePatient) PatientPicker(vm, session, onDismiss = { choosePatient = false }, onPick = { p ->
        choosePatient = false
        scope.launch { try { loadDraft(p.str("id")) } catch (e: Exception) { err = e.message } }
    })
}

@Composable
private fun TotalRow(label: String, x: Double, big: Boolean = false, color: androidx.compose.ui.graphics.Color = Ui.Text) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = color, modifier = Modifier.weight(1f), fontWeight = if (big) FontWeight.Bold else FontWeight.Normal, fontSize = if (big) 17.sp else 14.sp)
        Text(rupees(x), color = color, fontFamily = FontFamily.Monospace, fontWeight = if (big) FontWeight.Bold else FontWeight.Normal, fontSize = if (big) 18.sp else 14.sp)
    }
}

// ---------------- bill view: receipt, collect balance, cancel, share ----------------

@Composable
fun BillView(vm: CallViewModel, session: String, start: JSONObject, onDismiss: () -> Unit, onChanged: () -> Unit = {}) {
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var b by remember { mutableStateOf(start) }
    var paying by remember { mutableStateOf(false) }
    var cancelling by remember { mutableStateOf(false) }
    var mode by remember { mutableStateOf("Cash") }
    var amount by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    val st = b.str("status")
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(Ui.Bg)) {
            Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, "Close", tint = Ui.Text) }
                Text("${b.str("deptName")} bill", color = Ui.Text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Serif, modifier = Modifier.weight(1f))
                TextButton(onClick = { shareText(context, billText(b, "")) }) { Text("Share") }
            }
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                BoxCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(b.str("no"), color = Ui.Text, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.weight(1f))
                        Pill(billStatusLabel(st), billStatusColor(st))
                    }
                    val p = b.obj("patient")
                    Text(p.str("name") + if (p.str("id").isNotBlank()) " · ${p.str("id")}" else "", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                    Text(whenText(b.optLong("created")) + " · by ${b.str("createdBy")}", color = Ui.Muted, fontSize = 12.sp)
                    if (b.str("admissionNo").isNotBlank()) Text("${b.str("admissionNo")} · ${b.str("ward")} ${b.str("bed")}\n${whenText(b.optLong("admittedAt"))} → ${whenText(b.optLong("dischargedAt"))}", color = Ui.Muted, fontSize = 12.sp)
                }
                BoxCard {
                    b.objs("items").forEach { it ->
                        Row(verticalAlignment = Alignment.Top) {
                            Column(Modifier.weight(1f)) {
                                Text(it.str("desc"), color = Ui.Text, fontSize = 14.sp)
                                Text("${numText(it.num("qty"))} × ${rupees(it.num("rate"))}", color = Ui.Muted, fontSize = 12.sp)
                            }
                            Text(rupees(it.num("amount")), color = Ui.Text, fontFamily = FontFamily.Monospace)
                        }
                    }
                    HorizontalDivider(color = Ui.Line)
                    TotalRow("Subtotal", b.num("subtotal"))
                    if (b.num("discount") > 0) TotalRow("Discount", -b.num("discount"))
                    TotalRow("Total", b.num("total"), big = true)
                    b.objs("payments").forEach { pm -> TotalRow("Paid · ${pm.str("mode")}${if (pm.str("ref").isNotBlank()) " " + pm.str("ref") else ""}", pm.num("amount"), color = Ui.Green) }
                    val bal = b.num("balance")
                    if (bal > 0.004 && st != "to-ip") TotalRow("Balance due", bal, big = true, color = Ui.Red)
                    if (bal < -0.004) TotalRow("Refund due", -bal, big = true, color = Ui.Amber)
                }
                if (st == "cancelled") Text("Cancelled by ${b.str("cancelledBy")}${if (b.str("cancelReason").isNotBlank()) ": " + b.str("cancelReason") else ""}", color = Ui.Muted)
                ErrorText(err)
                if (paying) BoxCard {
                    Text("Collect balance", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { PAY_MODES.forEach { m -> Choice(m, mode == m, modifier = Modifier.weight(1f)) { mode = m } } }
                    OutlinedTextField(amount.ifBlank { numText(b.num("balance")) }, { amount = it.filter { c -> c.isDigit() || c == '.' }.take(9) }, label = { Text("Amount ₹") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
                    Button(onClick = {
                        scope.launch {
                            try {
                                b = api.call("/api/bills/pay", JSONObject().put("session", session).put("id", b.str("id")).put("mode", mode)
                                    .put("amount", amount.ifBlank { numText(b.num("balance")) }.toDoubleOrNull() ?: 0.0)).getJSONObject("bill")
                                paying = false; amount = ""; onChanged()
                                Toast.makeText(context, "Payment saved", Toast.LENGTH_SHORT).show()
                            } catch (e: Exception) { err = e.message }
                        }
                    }, modifier = Modifier.fillMaxWidth()) { Text("Save payment") }
                }
                if (cancelling) BoxCard {
                    Text("Cancel this bill?", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                    if (b.str("dept") == "pharmacy") Text("The medicines go back into stock.", color = Ui.Muted, fontSize = 13.sp)
                    OutlinedTextField(reason, { reason = it.take(200) }, label = { Text("Reason") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = {
                            scope.launch {
                                try {
                                    api.call("/api/bills/cancel", JSONObject().put("session", session).put("id", b.str("id")).put("reason", reason))
                                    b = JSONObject(b.toString()).put("status", "cancelled").put("cancelReason", reason).put("cancelledBy", vm.prefs.doctorName)
                                    cancelling = false; onChanged()
                                } catch (e: Exception) { err = e.message }
                            }
                        }) { Text("Cancel bill") }
                        TextButton(onClick = { cancelling = false }) { Text("Keep it") }
                    }
                }
            }
            if (!paying && !cancelling && st != "cancelled" && st != "on-ip-bill") Row(Modifier.fillMaxWidth().background(Ui.Card).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (b.num("balance") > 0.004 && st != "to-ip") Button(onClick = { paying = true }, modifier = Modifier.weight(1f)) { Text("Collect ${rupees(b.num("balance"))}") }
                if (b.str("dept") != "ip") OutlinedButton(onClick = { cancelling = true }, modifier = Modifier.weight(1f)) { Text("Cancel bill") }
            }
        }
    }
}

// ---------------- bill list, used in every billing section ----------------

@Composable
fun BillsPanel(vm: CallViewModel, session: String, dept: String, refreshKey: Int = 0, onNew: (() -> Unit)? = null, newLabel: String = "New bill") {
    val api = remember { Api(vm.prefs.serverUrl) }
    var date by remember { mutableStateOf(LocalDate.now().toString()) }
    var tick by remember { mutableIntStateOf(0) }
    val list = remember { mutableStateListOf<JSONObject>() }
    var err by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var open by remember { mutableStateOf<JSONObject?>(null) }
    LaunchedEffect(date, tick, refreshKey) {
        loading = true; err = null
        try { val r = api.call("/api/bills/list", JSONObject().put("session", session).put("dept", dept).put("date", date)).objs("bills"); list.clear(); list.addAll(r) }
        catch (e: Exception) { err = e.message }
        loading = false
    }
    val live = list.filter { it.str("status") != "cancelled" }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                IconButton(onClick = { date = LocalDate.parse(date).minusDays(1).toString() }) { Text("‹", fontSize = 22.sp, color = Ui.Text) }
                Text(dayLabel(date), color = Ui.Text, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                IconButton(onClick = { date = LocalDate.parse(date).plusDays(1).toString() }) { Text("›", fontSize = 22.sp, color = Ui.Text) }
                IconButton(onClick = { tick++ }) { Icon(Icons.Filled.Refresh, "Refresh", tint = Ui.Text) }
            }
            if (onNew != null) Button(onClick = onNew, modifier = Modifier.fillMaxWidth()) { Text(newLabel) }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                MiniStat("Billed", rupees(live.filter { it.str("status") != "to-ip" && it.str("status") != "on-ip-bill" }.sumOf { it.num("total") }), Modifier.weight(1f))
                MiniStat("Collected", rupees(live.sumOf { b -> b.objs("payments").filter { it.str("mode") != "Advance" }.sumOf { it.num("amount") } }), Modifier.weight(1f))
                MiniStat("Due", rupees(live.filter { it.str("status") == "unpaid" || it.str("status") == "partial" }.sumOf { it.num("balance") }), Modifier.weight(1f))
            }
        }
        item { ErrorText(err) }
        if (loading && list.isEmpty()) item { CircularProgressIndicator(color = Ui.Teal) }
        if (!loading && list.isEmpty() && err == null) item { Text("No bills on this day.", color = Ui.Muted) }
        items(list, key = { it.str("id") }) { b -> BillRow(b) { open = b } }
    }
    open?.let { b -> BillView(vm, session, b, onDismiss = { open = null; tick++ }) }
}

@Composable
internal fun BillRow(b: JSONObject, onClick: () -> Unit) {
    RowCard(onClick = onClick) {
        Column(Modifier.weight(1f)) {
            Text("${b.str("no")} · ${b.obj("patient").str("name")}", color = Ui.Text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOf(b.obj("patient").str("id"), "${b.objs("items").size} items", whenText(b.optLong("created"))).filter { it.isNotBlank() }.joinToString(" · "), color = Ui.Muted, fontSize = 12.sp)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(rupees(b.num("total")), color = Ui.Text, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold)
            Pill(billStatusLabel(b.str("status")), billStatusColor(b.str("status")))
        }
    }
}

@Composable
internal fun MiniStat(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier.clip(RoundedCornerShape(12.dp)).background(Ui.Card).padding(10.dp)) {
        Text(label.uppercase(), color = Ui.Muted, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        Text(value, color = Ui.Text, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 1)
    }
}

// ---------------- Billing desk: OPD bills, patient total, inpatients, collections ----------------

@Composable
fun BillingScreen(vm: CallViewModel, onBack: () -> Unit, onPatients: () -> Unit, onSignedOut: () -> Unit) {
    val session = vm.prefs.sessionFor("billing") ?: run { LaunchedEffect(Unit) { onSignedOut() }; return }
    var tab by remember { mutableStateOf("opd") }
    var newOpd by remember { mutableStateOf(false) }
    var opdPatient by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    Column(Modifier.fillMaxSize()) {
        TopBar("Billing", onBack) {
            TextButton(onClick = onPatients) { Text("Patients") }
            AccountButton(vm, onSignedOut)
        }
        FlowRow(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("opd" to "OPD bills", "total" to "Patient total", "ip" to "Inpatients", "day" to "Collections").forEach { (k, l) -> Choice(l, tab == k) { tab = k } }
        }
        when (tab) {
            "opd" -> BillsPanel(vm, session, "opd", refresh, onNew = { newOpd = true }, newLabel = "New OPD bill (consultation, procedures)")
            "total" -> PatientTotal(vm, session)
            "ip" -> InpatientsPanel(vm, session, canBill = true)
            else -> CollectionsPanel(vm, session)
        }
    }
    if (newOpd) PatientPicker(vm, session, "OPD bill for", onDismiss = { newOpd = false }, onPick = { newOpd = false; opdPatient = it.str("id") })
    opdPatient?.let { pid -> BillEditor(vm, session, "opd", patientId = pid, onDismiss = { opdPatient = null }, onSaved = { opdPatient = null; refresh++ }) }
}

@Composable
private fun PatientTotal(vm: CallViewModel, session: String) {
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    var picking by remember { mutableStateOf(true) }
    var data by remember { mutableStateOf<JSONObject?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    var open by remember { mutableStateOf<JSONObject?>(null) }
    fun load(pid: String) = scope.launch {
        try { data = api.call("/api/bills/patient", JSONObject().put("session", session).put("patientId", pid)); err = null } catch (e: Exception) { err = e.message }
    }
    val d = data
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { OutlinedButton(onClick = { picking = true }, modifier = Modifier.fillMaxWidth()) { Text(if (d == null) "Choose patient" else "Choose another patient") } }
        item { ErrorText(err) }
        if (d != null) {
            item { PatientIdCard(d.getJSONObject("patient")) }
            item {
                BoxCard {
                    Text("Hospital total", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, fontFamily = FontFamily.Serif)
                    Row { Text("", modifier = Modifier.weight(1.3f)); listOf("Billed", "Paid", "Due").forEach { Text(it, color = Ui.Muted, fontSize = 11.sp, modifier = Modifier.weight(1f)) } }
                    val bd = d.getJSONObject("byDept")
                    DEPT_TITLES.forEach { (k, t) ->
                        val x = bd.optJSONObject(k)
                        if (x != null && x.optInt("count") > 0) Row {
                            Text(t, color = Ui.Text, fontSize = 13.sp, modifier = Modifier.weight(1.3f))
                            listOf("billed", "paid", "due").forEach { f -> Text(rupees(x.num(f)), color = if (f == "due" && x.num(f) > 0) Ui.Red else Ui.Text, fontSize = 13.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f)) }
                        }
                    }
                    HorizontalDivider(color = Ui.Line)
                    val t = d.getJSONObject("total")
                    Row {
                        Text("Total", color = Ui.Text, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1.3f))
                        listOf("billed", "paid", "due").forEach { f -> Text(rupees(t.num(f)), color = if (f == "due" && t.num(f) > 0) Ui.Red else Ui.Text, fontWeight = FontWeight.Bold, fontSize = 13.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f)) }
                    }
                    if (d.objs("running").isNotEmpty()) Text("Includes the running inpatient account (not yet discharged).", color = Ui.Muted, fontSize = 12.sp)
                }
            }
            item { Text("Bills", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 17.sp) }
            items(d.objs("bills"), key = { it.str("id") }) { b -> BillRow(b) { open = b } }
        }
    }
    if (picking) PatientPicker(vm, session, "Patient total for", onDismiss = { picking = false }, onPick = { picking = false; load(it.str("id")) })
    open?.let { b -> BillView(vm, session, b, onDismiss = { open = null; d?.getJSONObject("patient")?.str("id")?.let { load(it) } }) }
}

@Composable
private fun CollectionsPanel(vm: CallViewModel, session: String) {
    val api = remember { Api(vm.prefs.serverUrl) }
    var date by remember { mutableStateOf(LocalDate.now().toString()) }
    var data by remember { mutableStateOf<JSONObject?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(date) {
        data = null
        try { data = api.call("/api/bills/summary", JSONObject().put("session", session).put("from", date).put("to", date)) } catch (e: Exception) { err = e.message }
    }
    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { date = LocalDate.parse(date).minusDays(1).toString() }) { Text("‹", fontSize = 22.sp, color = Ui.Text) }
            Text(dayLabel(date), color = Ui.Text, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            IconButton(onClick = { date = LocalDate.parse(date).plusDays(1).toString() }) { Text("›", fontSize = 22.sp, color = Ui.Text) }
        }
        ErrorText(err)
        val d = data ?: run { CircularProgressIndicator(color = Ui.Teal); return@Column }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            MiniStat("Billed", rupees(d.obj("totals").num("billed")), Modifier.weight(1f))
            MiniStat("Collected", rupees(d.obj("totals").num("collected")), Modifier.weight(1f))
        }
        BoxCard {
            Text("By department", color = Ui.Text, fontWeight = FontWeight.SemiBold)
            DEPT_TITLES.forEach { (k, t) ->
                val x = d.obj("byDept")?.optJSONObject(k)
                Row {
                    Text(t, color = Ui.Text, modifier = Modifier.weight(1.2f), fontSize = 14.sp)
                    Text(rupees(x.num("billed")), color = Ui.Text, fontFamily = FontFamily.Monospace, fontSize = 13.sp, modifier = Modifier.weight(1f))
                    Text(rupees(x.num("collected")), color = Ui.Green, fontFamily = FontFamily.Monospace, fontSize = 13.sp, modifier = Modifier.weight(1f))
                }
            }
            Text("Billed · Collected (inpatient = advances and final payments)", color = Ui.Muted, fontSize = 11.sp)
        }
        BoxCard {
            Text("By payment mode", color = Ui.Text, fontWeight = FontWeight.SemiBold)
            val m = d.obj("byMode")
            if (m == null || m.length() == 0) Text("No money received.", color = Ui.Muted)
            m?.keys()?.forEach { k -> TotalRow(k, m.num(k)) }
        }
    }
}

// ---------------- Inpatients ----------------

@Composable
fun InpatientsScreen(vm: CallViewModel, onBack: () -> Unit, onSignedOut: () -> Unit) {
    val session = vm.prefs.sessionFor("staff") ?: vm.prefs.sessionFor("doctor") ?: vm.prefs.sessionFor("billing") ?: run { LaunchedEffect(Unit) { onSignedOut() }; return }
    Column(Modifier.fillMaxSize()) {
        TopBar("Inpatients", onBack) { AccountButton(vm, onSignedOut) }
        InpatientsPanel(vm, session, canBill = vm.prefs.staffRole == "billing" || vm.prefs.staffRole == "admin")
    }
}

@Composable
fun InpatientsPanel(vm: CallViewModel, session: String, canBill: Boolean) {
    val api = remember { Api(vm.prefs.serverUrl) }
    var status by remember { mutableStateOf("admitted") }
    var tick by remember { mutableIntStateOf(0) }
    val list = remember { mutableStateListOf<JSONObject>() }
    var err by remember { mutableStateOf<String?>(null) }
    var admitting by remember { mutableStateOf(false) }
    var admitFor by remember { mutableStateOf<JSONObject?>(null) }
    var open by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(status, tick) {
        try { val r = api.call("/api/ip/list", JSONObject().put("session", session).put("status", status)).objs("admissions"); list.clear(); list.addAll(r); err = null }
        catch (e: Exception) { err = e.message }
    }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Choice("Admitted", status == "admitted", modifier = Modifier.weight(1f)) { status = "admitted" }
                Choice("Discharged", status == "discharged", modifier = Modifier.weight(1f)) { status = "discharged" }
            }
            Spacer(Modifier.height(8.dp))
            Button(onClick = { admitting = true }, modifier = Modifier.fillMaxWidth()) { Text("Admit a patient") }
        }
        item { ErrorText(err) }
        if (list.isEmpty() && err == null) item { Text(if (status == "admitted") "No patients admitted." else "No discharges yet.", color = Ui.Muted) }
        items(list, key = { it.str("id") }) { a ->
            RowCard(onClick = { open = a.str("id") }) {
                Column(Modifier.weight(1f)) {
                    Text("${a.obj("patient").str("name")} · ${a.obj("patient").str("id")}", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                    Text("${a.str("no")} · ${a.str("ward")} ${a.str("bed")} · day ${a.optInt("days")}", color = Ui.Muted, fontSize = 12.sp)
                    if (a.str("doctor").isNotBlank()) Text(a.str("doctor"), color = Ui.Muted, fontSize = 12.sp)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(rupees(a.num("total")), color = Ui.Text, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold)
                    Text("Advance ${rupees(a.num("advance"))}", color = Ui.Green, fontSize = 11.sp)
                }
            }
        }
    }
    if (admitting) PatientPicker(vm, session, "Admit", onDismiss = { admitting = false }, onPick = { admitting = false; admitFor = it })
    admitFor?.let { p -> AdmitDialog(vm, session, p, canBill, onDismiss = { admitFor = null }, onDone = { id -> admitFor = null; tick++; open = id }) }
    open?.let { id -> AdmissionView(vm, session, id, canBill, onDismiss = { open = null; tick++ }) }
}

@Composable
private fun AdmitDialog(vm: CallViewModel, session: String, p: JSONObject, canBill: Boolean, onDismiss: () -> Unit, onDone: (String) -> Unit) {
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    val wards = remember { mutableStateListOf<JSONObject>() }
    var ward by remember { mutableStateOf("") }
    var bed by remember { mutableStateOf("") }
    var doctor by remember { mutableStateOf(if (vm.prefs.staffRole == "doctor") vm.prefs.doctorName else "") }
    var reason by remember { mutableStateOf("") }
    var advance by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf("Cash") }
    var err by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        runCatching { api.call("/api/tariff/list", JSONObject().put("session", session).put("dept", "ip")).objs("tariff").filter { it.str("unit") == "per day" && !it.str("name").contains("Nursing") && !it.str("name").contains("Oxygen") } }
            .onSuccess { wards.addAll(it); ward = it.firstOrNull()?.str("name").orEmpty() }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Admit ${p.str("name")}") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Ward / room (per day)", color = Ui.Muted, fontSize = 13.sp)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    wards.forEach { w -> Choice("${w.str("name")} ${rupees(w.num("price"))}", ward == w.str("name")) { ward = w.str("name") } }
                }
                OutlinedTextField(bed, { bed = it.take(20) }, label = { Text("Bed number") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(doctor, { doctor = it.take(80) }, label = { Text("Admitting doctor") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(reason, { reason = it.take(300) }, label = { Text("Reason / diagnosis") }, modifier = Modifier.fillMaxWidth())
                if (canBill) {
                    OutlinedTextField(advance, { advance = it.filter { c -> c.isDigit() || c == '.' }.take(9) }, label = { Text("Advance received ₹ (optional)") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { PAY_MODES.forEach { m -> Choice(m, mode == m, modifier = Modifier.weight(1f)) { mode = m } } }
                }
                ErrorText(err)
            }
        },
        confirmButton = {
            Button(enabled = ward.isNotBlank(), onClick = {
                scope.launch {
                    try {
                        val body = JSONObject().put("session", session).put("patientId", p.str("id")).put("ward", ward).put("bed", bed).put("doctor", doctor).put("reason", reason)
                        if ((advance.toDoubleOrNull() ?: 0.0) > 0) body.put("deposit", JSONObject().put("amount", advance.toDouble()).put("mode", mode))
                        onDone(api.call("/api/ip/admit", body).getJSONObject("admission").str("id"))
                    } catch (e: Exception) { err = e.message }
                }
            }) { Text("Admit") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun AdmissionView(vm: CallViewModel, session: String, id: String, canBill: Boolean, onDismiss: () -> Unit) {
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var data by remember { mutableStateOf<JSONObject?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    var tick by remember { mutableIntStateOf(0) }
    var panel by remember { mutableStateOf("") } // charge, advance, transfer, discharge
    val tariffIp = remember { mutableStateListOf<JSONObject>() }
    var finalBill by remember { mutableStateOf<JSONObject?>(null) }
    LaunchedEffect(tick) {
        try { data = api.call("/api/ip/get", JSONObject().put("session", session).put("id", id)); err = null } catch (e: Exception) { err = e.message }
        if (tariffIp.isEmpty()) runCatching { api.call("/api/tariff/list", JSONObject().put("session", session).put("dept", "ip")).objs("tariff") }.onSuccess { tariffIp.addAll(it) }
    }
    fun update(extra: JSONObject) = scope.launch {
        try { api.call("/api/ip/update", extra.put("session", session).put("id", id)); panel = ""; tick++ }
        catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't save", Toast.LENGTH_LONG).show() }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(Ui.Bg).imePadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, "Close", tint = Ui.Text) }
                Text("Inpatient account", color = Ui.Text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Serif, modifier = Modifier.weight(1f))
            }
            val d = data ?: run { Box(Modifier.padding(16.dp)) { if (err != null) ErrorText(err) else CircularProgressIndicator(color = Ui.Teal) }; return@Column }
            val a = d.getJSONObject("admission"); val acc = d.getJSONObject("account")
            val admitted = a.str("status") == "admitted"
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                BoxCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(a.str("no"), color = Ui.Text, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.weight(1f))
                        Pill(if (admitted) "Admitted · day ${acc.optInt("days")}" else "Discharged", if (admitted) Ui.Ai else Ui.Green)
                    }
                    Text("${a.obj("patient").str("name")} · ${a.obj("patient").str("id")}", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                    Text("${a.str("ward")} · bed ${a.str("bed").ifBlank { "–" }}${if (a.str("doctor").isNotBlank()) " · " + a.str("doctor") else ""}", color = Ui.Muted, fontSize = 13.sp)
                    Text("Admitted ${whenText(a.optLong("admittedAt"))}" + if (!admitted) "\nDischarged ${whenText(a.optLong("dischargedAt"))}" else "", color = Ui.Muted, fontSize = 12.sp)
                    if (a.str("reason").isNotBlank()) Text(a.str("reason"), color = Ui.Text, fontSize = 13.sp)
                }
                BoxCard {
                    Text("Charges so far", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                    acc.objs("lines").forEach { l ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(l.str("desc"), color = Ui.Text, fontSize = 14.sp)
                                Text("${numText(l.num("qty"))} × ${rupees(l.num("rate"))}${if (l.str("date").isNotBlank()) " · " + dayLabel(l.str("date")) else ""}", color = Ui.Muted, fontSize = 12.sp)
                            }
                            Text(rupees(l.num("amount")), color = Ui.Text, fontFamily = FontFamily.Monospace)
                            if (admitted && canBill && l.str("kind") == "charge") IconButton(onClick = { update(JSONObject().put("removeCharge", l.str("id"))) }) { Icon(Icons.Filled.Close, "Remove", tint = Ui.Red) }
                        }
                    }
                    HorizontalDivider(color = Ui.Line)
                    TotalRow("Total", acc.num("total"), big = true)
                    TotalRow("Advance received", acc.num("advance"), color = Ui.Green)
                    TotalRow(if (acc.num("due") >= 0) "Balance" else "Refund", kotlin.math.abs(acc.num("due")), big = true, color = if (acc.num("due") > 0) Ui.Red else Ui.Amber)
                    Text("Pharmacy, lab and diagnostics bills marked \"Add to IP bill\" appear here automatically.", color = Ui.Muted, fontSize = 12.sp)
                }
                if (admitted) when (panel) {
                    "charge" -> ChargePanel(tariffIp, onCancel = { panel = "" }, onAdd = { c -> update(JSONObject().put("charge", c)) })
                    "advance" -> AmountPanel("Advance received", onCancel = { panel = "" }) { amt, m -> update(JSONObject().put("deposit", JSONObject().put("amount", amt).put("mode", m))) }
                    "transfer" -> TransferPanel(tariffIp.filter { it.str("unit") == "per day" && !it.str("name").contains("Nursing") && !it.str("name").contains("Oxygen") }, a.str("bed"),
                        onCancel = { panel = "" }) { ward, bed -> update(JSONObject().put("bed", bed).apply { if (ward != a.str("ward")) put("ward", ward) }) }
                    "discharge" -> DischargePanel(acc.num("total"), acc.num("advance"), onCancel = { panel = "" }) { disc, amt, m ->
                        scope.launch {
                            try {
                                val body = JSONObject().put("session", session).put("id", id).put("discount", disc)
                                if (amt > 0) body.put("pay", JSONObject().put("amount", amt).put("mode", m))
                                finalBill = api.call("/api/ip/discharge", body).getJSONObject("bill"); panel = ""; tick++
                            } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't discharge", Toast.LENGTH_LONG).show() }
                        }
                    }
                    else -> FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { panel = "charge" }) { Text("Add charge") }
                        OutlinedButton(onClick = { panel = "transfer" }) { Text("Change ward / bed") }
                        if (canBill) OutlinedButton(onClick = { panel = "advance" }) { Text("Take advance") }
                        if (canBill) Button(onClick = { panel = "discharge" }) { Text("Discharge & final bill") }
                    }
                }
                d.optJSONObject("finalBill")?.let { fb -> OutlinedButton(onClick = { finalBill = fb }, modifier = Modifier.fillMaxWidth()) { Text("Final bill ${fb.str("no")} · ${rupees(fb.num("total"))}") } }
            }
        }
    }
    finalBill?.let { b -> BillView(vm, session, b, onDismiss = { finalBill = null; tick++ }) }
}

@Composable
private fun ChargePanel(tariff: List<JSONObject>, onCancel: () -> Unit, onAdd: (JSONObject) -> Unit) {
    var desc by remember { mutableStateOf("") }
    var qty by remember { mutableStateOf("1") }
    var rate by remember { mutableStateOf("") }
    BoxCard {
        Text("Add charge", color = Ui.Text, fontWeight = FontWeight.SemiBold)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            tariff.filter { it.str("unit") != "per day" || it.str("name").contains("Nursing") || it.str("name").contains("Oxygen") }.forEach { t ->
                Choice(t.str("name"), desc == t.str("name")) { desc = t.str("name"); rate = numText(t.num("price")) }
            }
        }
        OutlinedTextField(desc, { desc = it.take(160) }, label = { Text("Charge for") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(qty, { qty = it.filter { c -> c.isDigit() || c == '.' }.take(6) }, label = { Text("Qty / days") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f))
            OutlinedTextField(rate, { rate = it.filter { c -> c.isDigit() || c == '.' }.take(9) }, label = { Text("Rate ₹") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = desc.isNotBlank() && (qty.toDoubleOrNull() ?: 0.0) > 0, onClick = {
                onAdd(JSONObject().put("desc", desc.trim()).put("qty", qty.toDoubleOrNull() ?: 1.0).put("rate", rate.toDoubleOrNull() ?: 0.0))
            }) { Text("Add") }
            TextButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}

@Composable
private fun AmountPanel(title: String, onCancel: () -> Unit, onSave: (Double, String) -> Unit) {
    var amt by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf("Cash") }
    BoxCard {
        Text(title, color = Ui.Text, fontWeight = FontWeight.SemiBold)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { PAY_MODES.forEach { m -> Choice(m, mode == m, modifier = Modifier.weight(1f)) { mode = m } } }
        OutlinedTextField(amt, { amt = it.filter { c -> c.isDigit() || c == '.' }.take(9) }, label = { Text("Amount ₹") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = (amt.toDoubleOrNull() ?: 0.0) > 0, onClick = { onSave(amt.toDouble(), mode) }) { Text("Save") }
            TextButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}

@Composable
private fun TransferPanel(wards: List<JSONObject>, bedNow: String, onCancel: () -> Unit, onSave: (String, String) -> Unit) {
    var ward by remember { mutableStateOf("") }
    var bed by remember { mutableStateOf(bedNow) }
    BoxCard {
        Text("Change ward or bed", color = Ui.Text, fontWeight = FontWeight.SemiBold)
        Text("A ward change bills the days so far at the old rate.", color = Ui.Muted, fontSize = 12.sp)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            wards.forEach { w -> Choice("${w.str("name")} ${rupees(w.num("price"))}", ward == w.str("name")) { ward = w.str("name") } }
        }
        OutlinedTextField(bed, { bed = it.take(20) }, label = { Text("Bed") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { onSave(ward, bed) }) { Text("Save") }
            TextButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}

@Composable
private fun DischargePanel(total: Double, advance: Double, onCancel: () -> Unit, onDone: (Double, Double, String) -> Unit) {
    var disc by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf("Cash") }
    val d = (disc.toDoubleOrNull() ?: 0.0).coerceIn(0.0, total)
    val due = (total - d - advance).coerceAtLeast(0.0)
    var amt by remember { mutableStateOf<String?>(null) }
    BoxCard {
        Text("Discharge and final bill", color = Ui.Text, fontWeight = FontWeight.SemiBold)
        TotalRow("Total charges", total)
        OutlinedTextField(disc, { disc = it.filter { c -> c.isDigit() || c == '.' }.take(9) }, label = { Text("Discount ₹") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
        TotalRow("Advance", -advance, color = Ui.Green)
        TotalRow(if (total - d - advance >= 0) "To pay now" else "Refund to patient", kotlin.math.abs(total - d - advance), big = true)
        if (due > 0) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { PAY_MODES.forEach { m -> Choice(m, mode == m, modifier = Modifier.weight(1f)) { mode = m } } }
            OutlinedTextField(amt ?: numText(due), { amt = it.filter { c -> c.isDigit() || c == '.' }.take(9) }, label = { Text("Amount received ₹") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { onDone(d, if (due > 0) (amt ?: numText(due)).toDoubleOrNull() ?: 0.0 else 0.0, mode) }) { Text("Discharge") }
            TextButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}

// ---------------- Admin: price list ----------------

@Composable
fun PriceListScreen(vm: CallViewModel, onBack: () -> Unit) {
    val session = vm.prefs.session("admin") ?: run { LaunchedEffect(Unit) { onBack() }; return }
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var dept by remember { mutableStateOf("opd") }
    var tick by remember { mutableIntStateOf(0) }
    val list = remember { mutableStateListOf<JSONObject>() }
    var name by remember { mutableStateOf("") }
    var price by remember { mutableStateOf("") }
    var perDay by remember { mutableStateOf(false) }
    LaunchedEffect(dept, tick) {
        runCatching { api.call("/api/tariff/list", JSONObject().put("session", session).put("dept", dept)).objs("tariff") }.onSuccess { list.clear(); list.addAll(it) }
    }
    fun save(item: JSONObject) = scope.launch {
        try { api.call("/api/tariff/save", JSONObject().put("session", session).put("item", item)); tick++ }
        catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't save", Toast.LENGTH_LONG).show() }
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar("Price list", onBack)
        Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("opd" to "OPD", "lab" to "Lab", "diagnostics" to "Diagnostics", "ip" to "Inpatient").forEach { (k, l) -> Choice(l, dept == k, modifier = Modifier.weight(1f)) { dept = k } }
        }
        Text("Example prices are filled in. Change them to your clinic's rates. Medicine prices are set in Pharmacy → Stock.", color = Ui.Muted, fontSize = 12.sp, modifier = Modifier.padding(16.dp, 8.dp))
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                BoxCard {
                    Text("Add", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(name, { name = it.take(100) }, label = { Text("Name") }, singleLine = true, modifier = Modifier.weight(1.5f))
                        OutlinedTextField(price, { price = it.filter { c -> c.isDigit() || c == '.' }.take(9) }, label = { Text("₹") }, singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f))
                    }
                    if (dept == "ip") Row(verticalAlignment = Alignment.CenterVertically) { Text("Charged per day (rooms, nursing)", color = Ui.Text, modifier = Modifier.weight(1f)); Switch(perDay, { perDay = it }) }
                    Button(enabled = name.isNotBlank(), onClick = {
                        save(JSONObject().put("dept", dept).put("name", name.trim()).put("price", price.toDoubleOrNull() ?: 0.0).put("unit", if (perDay && dept == "ip") "per day" else "each"))
                        name = ""; price = ""
                    }) { Text("Add") }
                }
            }
            items(list, key = { it.str("id") }) { t -> TariffRow(t, onSave = { p -> save(JSONObject(t.toString()).put("price", p)) }, onDelete = {
                scope.launch { runCatching { api.call("/api/tariff/delete", JSONObject().put("session", session).put("id", t.str("id"))) }; tick++ }
            }) }
        }
    }
}

@Composable
private fun TariffRow(t: JSONObject, onSave: (Double) -> Unit, onDelete: () -> Unit) {
    var p by remember(t.str("id"), t.num("price")) { mutableStateOf(numText(t.num("price"))) }
    RowCard {
        Column(Modifier.weight(1f)) {
            Text(t.str("name"), color = Ui.Text, fontWeight = FontWeight.SemiBold)
            if (t.str("unit") == "per day") Text("per day", color = Ui.Muted, fontSize = 12.sp)
        }
        OutlinedTextField(p, { p = it.filter { c -> c.isDigit() || c == '.' }.take(9) }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.width(96.dp))
        TextButton(onClick = { onSave(p.toDoubleOrNull() ?: 0.0) }) { Text("Save") }
        TextButton(onClick = onDelete) { Text("Delete", color = Ui.Red) }
    }
}
