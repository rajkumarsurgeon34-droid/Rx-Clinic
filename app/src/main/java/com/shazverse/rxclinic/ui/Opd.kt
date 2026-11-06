@file:OptIn(ExperimentalLayoutApi::class)

package com.shazverse.rxclinic.ui

import android.content.Intent
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Badge
import androidx.compose.material.icons.filled.LocalHospital
import androidx.compose.material.icons.filled.EventRepeat
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.EventAvailable
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.shazverse.rxclinic.Api
import com.shazverse.rxclinic.call.CallViewModel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

// ---------- JSON helpers ----------

internal fun orderStatusLabel(s: String) = when (s) {
    "ordered" -> "Ordered"; "collected" -> "Sample collected"; "scheduled" -> "Scan scheduled"; "reported" -> "Reported"; else -> s
}

internal fun JSONObject?.str(k: String): String {
    val v = this?.opt(k) ?: return ""
    return if (v == JSONObject.NULL) "" else v.toString()
}

internal fun JSONObject?.obj(k: String): JSONObject? = this?.optJSONObject(k)

internal fun JSONObject?.objs(k: String): List<JSONObject> {
    val a = this?.optJSONArray(k) ?: return emptyList()
    return (0 until a.length()).mapNotNull { a.optJSONObject(it) }
}

internal fun JSONObject?.strs(k: String): List<String> {
    val a = this?.optJSONArray(k) ?: return emptyList()
    return (0 until a.length()).map { a.opt(it) }.filter { it != null && it != JSONObject.NULL }.map { it.toString() }.filter { it.isNotBlank() }
}

data class RxItem(
    val generic: String, val form: String = "Tab", val strength: String = "", val dose: String = "1 tab",
    val frequency: String = "1-0-1", val timing: String = "After food", val duration: String = "5 days",
    val instructions: String = "", val fromAi: Boolean = false,
) {
    fun toJson(): JSONObject = JSONObject().put("generic", generic).put("form", form).put("strength", strength).put("dose", dose)
        .put("frequency", frequency).put("timing", timing).put("duration", duration).put("instructions", instructions)
        .put("source", if (fromAi) "ai" else "doctor")

    fun line() = "$form $generic $strength".replace(Regex("\\s+"), " ").trim()

    companion object {
        fun from(o: JSONObject) = RxItem(
            o.str("generic"), o.str("form").ifBlank { "Tab" }, o.str("strength"), o.str("dose"), o.str("frequency"),
            o.str("timing").ifBlank { "After food" }, o.str("duration"), o.str("instructions"), o.str("source") == "ai",
        )
    }
}

private val TIMINGS = listOf("After food", "Before food", "With food", "Empty stomach", "At bedtime", "As needed")
private val QUICK_ADVICE = listOf(
    "Take medicines exactly as written; complete the full course", "Avoid tea and coffee", "Avoid spicy, sour and oily foods",
    "Avoid junk and packaged foods", "Stop smoking", "Stop alcohol", "Sleep 7–8 hours a night", "Drink 2–3 litres of water a day",
    "Eat more vegetables, fruits and fibre", "Limit red meat", "Small, frequent meals",
    "Return immediately if pain worsens, fever rises or vomiting persists",
)

// ---------- Doctor home ----------

@Composable
fun DoctorHome(vm: CallViewModel, onBack: () -> Unit, onOpd: () -> Unit, onAppointments: () -> Unit, onPatients: () -> Unit, onInpatients: () -> Unit, onFollowUps: () -> Unit, onHmis: () -> Unit, onSignedOut: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        TopBar(vm.prefs.doctorName.ifBlank { "Doctor" }, onBack) {
            AccountButton(vm, onSignedOut)
        }
        Column(Modifier.padding(horizontal = 16.dp)) {
            RoleCard("OPD today", "Patients who checked in, their case sheets, AI suggestions and prescriptions", Icons.Filled.Groups, onOpd)
            RoleCard("Appointments and video teleconsults", "Bookings by day; start video calls", Icons.Filled.EventAvailable, onAppointments)
            RoleCard("Patient records", "Find by Patient ID, mobile, Aadhaar or name; register; past visits", Icons.Filled.Badge, onPatients)
            if (vm.prefs.has("ip")) RoleCard("Inpatients", "Admitted patients, admit, ward charges", Icons.Filled.LocalHospital, onInpatients)
            RoleCard("Follow-ups", "Reviews due, missed reviews, call-back list", Icons.Filled.EventRepeat, onFollowUps)
            RoleCard("HMIS workspace", "Dashboard and full patient chart: assessment, monitoring, results, orders, medicines, requests", Icons.Filled.Dashboard, onHmis)
        }
    }
}

// ---------- OPD queue ----------

@Composable
fun OpdQueue(vm: CallViewModel, onBack: () -> Unit, onOpen: (String) -> Unit, onSignedOut: () -> Unit) {
    val session = vm.prefs.sessionFor("doctor") ?: run { LaunchedEffect(Unit) { onSignedOut() }; return }
    val api = remember { Api(vm.prefs.serverUrl) }
    var date by rememberSaveable { mutableStateOf(LocalDate.now().toString()) }
    var refresh by remember { mutableIntStateOf(0) }
    val list = remember { mutableStateListOf<JSONObject>() }
    var loading by remember { mutableStateOf(true) }
    var err by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(date, refresh) {
        loading = true; err = null
        try { val v = api.visits(session, date); list.clear(); list.addAll(v) }
        catch (e: Exception) {
            if (e.message?.contains("Sign in", true) == true) { vm.prefs.saveSession("doctor", null); onSignedOut() } else err = e.message
        }
        loading = false
    }

    Column(Modifier.fillMaxSize()) {
        TopBar("OPD", onBack) { IconButton(onClick = { refresh++ }) { Icon(Icons.Filled.Refresh, "Refresh", tint = Ui.Text) } }
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { date = LocalDate.parse(date).minusDays(1).toString() }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Previous day", tint = Ui.Text) }
            Text("Checked in · ${dayLabel(date)}", color = Ui.Text, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            IconButton(onClick = { date = LocalDate.parse(date).plusDays(1).toString() }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Next day", tint = Ui.Text) }
        }
        Box(Modifier.padding(horizontal = 16.dp)) { ErrorText(err) }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (loading && list.isEmpty()) item { CircularProgressIndicator(color = Ui.Teal) }
            if (!loading && list.isEmpty() && err == null) item {
                Text("No patients have checked in on this day. Patients check in from Patient → Check-in.", color = Ui.Muted)
            }
            items(list, key = { it.str("id") }) { v ->
                val p = v.obj("patient")
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Ui.Card).border(1.dp, Ui.Line, RoundedCornerShape(16.dp)).clickable { onOpen(v.str("id")) }.padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(v.str("token"), color = Ui.Teal, fontSize = 22.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.width(44.dp))
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(p.str("name"), color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            if (v.optBoolean("urgent")) { Spacer(Modifier.width(6.dp)); Pill("Urgent", Ui.Red) }
                        }
                        Text("${p.str("age")} y · ${p.str("sex")} · ${v.str("complaint")}", color = Ui.Muted, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    val st = v.str("status")
                    Pill(when (st) { "waiting" -> "Waiting"; "consult" -> "In consult"; "sent" -> "Prescribed"; else -> st }, when (st) { "waiting" -> Ui.Amber; "sent" -> Ui.Green; else -> Ui.Teal })
                }
            }
        }
    }
}

// ---------- Case sheet ----------

@Composable
fun CaseScreen(vm: CallViewModel, visitId: String, onBack: () -> Unit) {
    val session = vm.prefs.sessionFor("doctor") ?: run { LaunchedEffect(Unit) { onBack() }; return }
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var visit by remember { mutableStateOf<JSONObject?>(null) }
    var loadErr by remember { mutableStateOf<String?>(null) }
    val vitals = remember { mutableStateMapOf<String, String>() }
    var exam by remember { mutableStateOf("") }
    var assessment by remember { mutableStateOf<JSONObject?>(null) }
    val ordered = remember { mutableStateListOf<String>() }
    var provisional by remember { mutableStateOf("") }
    var resultsText by remember { mutableStateOf("") }
    var analysis by remember { mutableStateOf<JSONObject?>(null) }
    var finalDx by remember { mutableStateOf("") }
    var treatment by remember { mutableStateOf<JSONObject?>(null) }
    val rx = remember { mutableStateListOf<RxItem>() }
    val advice = remember { mutableStateListOf<String>() }
    var surgery by remember { mutableStateOf("") }
    var physio by remember { mutableStateOf("") }
    var psych by remember { mutableStateOf("") }
    var review by remember { mutableStateOf("") }
    var reviewNote by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("waiting") }
    val busy = remember { mutableStateMapOf<String, Boolean>() }
    val errs = remember { mutableStateMapOf<String, String>() }
    var saveMsg by remember { mutableStateOf<String?>(null) }
    var newDrug by remember { mutableStateOf("") }
    var newAdvice by remember { mutableStateOf("") }
    val orders = remember { mutableStateListOf<JSONObject>() }
    var ordersTick by remember { mutableIntStateOf(0) }
    val stockNames = remember { mutableStateListOf<String>() }
    var stockText by remember { mutableStateOf("") }
    val history = remember { mutableStateListOf<JSONObject>() }
    var letterOpen by remember { mutableStateOf(false) }

    LaunchedEffect(visitId) {
        try {
            val res = api.call("/api/doctor/visit", JSONObject().put("session", session).put("id", visitId))
            val v = res.getJSONObject("visit")
            history.clear(); history.addAll(res.objs("history"))
            visit = v; status = v.str("status")
            val w = v.obj("work")
            if (w != null) {
                w.obj("vitals")?.let { vo -> vo.keys().forEach { k -> vitals[k] = vo.str(k) } }
                exam = w.str("exam"); assessment = w.obj("assessment"); ordered.addAll(w.strs("ordered"))
                provisional = w.str("provisional"); resultsText = w.str("resultsText"); analysis = w.obj("analysis")
                finalDx = w.str("finalDx"); treatment = w.obj("treatment")
                rx.addAll(w.objs("rx").map { RxItem.from(it) })
                val adv = w.optJSONArray("advice")
                if (adv != null) (0 until adv.length()).forEach { i ->
                    val a = adv.opt(i); advice.add(if (a is JSONObject) a.str("text") else a.toString())
                }
                surgery = w.str("surgeryPlan"); physio = w.str("physio"); psych = w.str("psych")
                review = w.str("review"); reviewNote = w.str("reviewNote")
            }
            // Vitals recorded by the nurse at triage fill any empty boxes
            v.obj("triage")?.obj("vitals")?.let { tv -> tv.keys().forEach { k -> if (vitals[k].isNullOrBlank() && tv.str(k).isNotBlank()) vitals[k] = tv.str(k) } }
        } catch (e: Exception) { loadErr = e.message }
        runCatching {
            val st = api.call("/api/pharmacy/stock", JSONObject().put("session", session)).objs("stock")
            stockNames.clear(); stockNames.addAll(st.filter { it.optInt("stock") > 0 }.map { it.str("generic") })
            stockText = st.joinToString("\n") { "${it.str("generic")} ${it.str("strength")} (${it.str("form")}) | stock ${it.optInt("stock")}" }
        }
    }

    LaunchedEffect(visitId, ordersTick) {
        runCatching {
            val o = api.call("/api/orders/list", JSONObject().put("session", session).put("visitId", visitId)).objs("orders")
            orders.clear(); orders.addAll(o)
        }
    }

    fun inStock(name: String): Boolean? {
        if (stockNames.isEmpty()) return null
        val n = name.lowercase().trim()
        if (n.length < 4) return null
        return stockNames.any { val g = it.lowercase(); g.length >= 4 && (n.contains(g) || g.contains(n)) }
    }

    fun workJson(): JSONObject {
        val vo = JSONObject(); vitals.forEach { (k, v) -> vo.put(k, v) }
        return JSONObject().put("vitals", vo).put("exam", exam).put("assessment", assessment ?: JSONObject.NULL)
            .put("ordered", JSONArray(ordered.toList())).put("provisional", provisional).put("resultsText", resultsText)
            .put("analysis", analysis ?: JSONObject.NULL).put("finalDx", finalDx).put("treatment", treatment ?: JSONObject.NULL)
            .put("rx", JSONArray().apply { rx.forEach { put(it.toJson()) } })
            .put("advice", JSONArray().apply { advice.forEach { put(JSONObject().put("text", it)) } })
            .put("surgeryPlan", surgery).put("physio", physio).put("psych", psych).put("review", review).put("reviewNote", reviewNote)
    }

    fun save(newStatus: String? = null, withRx: Boolean = false, quiet: Boolean = false) = scope.launch {
        saveMsg = null
        try {
            val patch = JSONObject().put("work", workJson())
            val st = newStatus ?: if (status == "waiting") "consult" else null
            if (st != null) patch.put("status", st)
            if (withRx) patch.put("rx", JSONObject()
                .put("items", JSONArray().apply { rx.forEach { put(it.toJson()) } })
                .put("advice", JSONArray(advice.toList())).put("dx", finalDx.ifBlank { provisional })
                .put("review", review).put("reviewNote", reviewNote).put("surgery", surgery).put("physio", physio).put("psych", psych)
                .put("sentAt", System.currentTimeMillis()).put("doctor", vm.prefs.doctorName))
            api.saveVisit(session, visitId, patch)
            if (st != null) status = st
            saveMsg = if (withRx) "Prescription saved and sent to the pharmacy." else "Saved."
            if (!quiet) Toast.makeText(context, saveMsg, Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            saveMsg = e.message ?: "Couldn't save"
            Toast.makeText(context, "Not saved: $saveMsg", Toast.LENGTH_LONG).show()
        }
    }

    fun runAi(key: String, prompt: () -> String, apply: (JSONObject) -> Unit) {
        busy[key] = true; errs.remove(key)
        scope.launch {
            try { apply(api.aiJson(session, prompt())); save(quiet = true) }
            catch (e: Exception) { errs[key] = e.message ?: "The AI could not answer. Try again." }
            finally { busy[key] = false }
        }
    }

    fun caseText(full: Boolean): String {
        val v = visit ?: return ""
        val p = v.obj("patient"); val cs = v.obj("caseSheet")
        val sb = StringBuilder("Patient: ${p.str("age")} years, ${p.str("sex")}. (Name withheld.)\n")
        if (cs != null) {
            val past = cs.obj("past"); val h = cs.obj("habits")
            sb.append("Chief complaints: ${cs.objs("chiefComplaints").joinToString("; ") { it.str("complaint") + " for " + it.str("duration") }}\n")
            sb.append("HPI: ${cs.str("hpi")}\nPast medical: ${past.str("medical")}\nPast surgical: ${past.str("surgical")}\n")
            sb.append("Transfusion: ${past.str("transfusion")}\nCurrent drugs: ${past.str("drugs")}\nDrug allergies: ${past.str("allergies")}\n")
            sb.append("Habits: smoking ${h.str("smoking")}; alcohol ${h.str("alcohol")}; tobacco ${h.str("tobacco")}; diet ${h.str("diet")}; sleep ${h.str("sleep")}; appetite/bowel/bladder ${h.str("appetiteBowelBladder")}\n")
            sb.append("Menstrual/obstetric: ${cs.str("menstrualObstetric")}\nFamily: ${cs.str("family")}\nRed flags: ${cs.strs("redFlags").joinToString("; ").ifBlank { "none" }}\n")
        } else {
            sb.append("Intake answers:\n"); v.objs("qa").forEach { sb.append("Q: ${it.str("q")}\nA: ${it.str("a")}\n") }
        }
        sb.append("Vitals: BP ${vitals["bp"].orEmpty()} mmHg, pulse ${vitals["pulse"].orEmpty()}/min, temp ${vitals["temp"].orEmpty()} °F, SpO2 ${vitals["spo2"].orEmpty()}%, RR ${vitals["rr"].orEmpty()}/min, RBS ${vitals["rbs"].orEmpty()} mg/dL, weight ${vitals["weight"].orEmpty()} kg\n")
        sb.append("Examination: ${exam.ifBlank { "not entered" }}\n")
        if (full) sb.append("Provisional diagnosis: ${provisional.ifBlank { "not set" }}\nInvestigations ordered: ${ordered.joinToString().ifBlank { "none" }}\nResults: ${resultsText.ifBlank { "none" }}\nFinal diagnosis: ${finalDx.ifBlank { "not set" }}\n")
        return sb.toString()
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar(visit?.obj("patient").str("name").ifBlank { "Case sheet" }, onBack) {
            TextButton(onClick = { save() }) { Text("Save") }
        }
        val v = visit
        if (v == null) {
            Box(Modifier.padding(16.dp)) { if (loadErr != null) ErrorText(loadErr) else CircularProgressIndicator(color = Ui.Teal) }
            return@Column
        }
        val p = v.obj("patient")
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (p.str("id").isNotBlank()) Pill("ID " + p.str("id"), Ui.Ai)
                    Text("${p.str("age")} y · ${p.str("sex")} · Token ${v.str("token")}", color = Ui.Muted)
                    if (v.optBoolean("urgent")) Pill("Urgent at check-in", Ui.Red)
                    Pill(when (status) { "waiting" -> "Waiting"; "consult" -> "In consult"; "sent" -> "Prescribed"; else -> status }, Ui.Teal)
                }
                saveMsg?.let { Text(it, color = if (it.endsWith(".")) Ui.Teal else Ui.Red, fontSize = 13.sp) }
            }

            if (history.isNotEmpty()) item { PreviousVisits(history) }

            // 1. History
            item {
                Section("1", "History") {
                    val cs = v.obj("caseSheet")
                    if (cs == null) {
                        Text("No structured case sheet yet.", color = Ui.Muted)
                        AiButton("Build case sheet from answers", busy["sheet"] == true) {
                            busy["sheet"] = true
                            scope.launch {
                                try {
                                    val qa = v.objs("qa").joinToString("\n") { "Q: ${it.str("q")}\nA: ${it.str("a")}" }
                                    val sheet = api.aiJson(session, "Convert this outpatient intake interview into a structured case sheet in ENGLISH for the treating doctor. Translate faithfully; use only what the patient said; write \"Not asked\" for topics not covered and \"Nil\" for denied ones. Do not diagnose.\nPatient: ${p.str("age")} years, ${p.str("sex")}.\n$qa\nReply with ONLY this JSON: {\"chiefComplaints\":[{\"complaint\":\"\",\"duration\":\"\"}],\"hpi\":\"\",\"past\":{\"medical\":\"\",\"surgical\":\"\",\"transfusion\":\"\",\"drugs\":\"\",\"allergies\":\"\"},\"habits\":{\"smoking\":\"\",\"alcohol\":\"\",\"tobacco\":\"\",\"diet\":\"\",\"sleep\":\"\",\"appetiteBowelBladder\":\"\"},\"menstrualObstetric\":\"\",\"family\":\"\",\"redFlags\":[]}")
                                    api.saveVisit(session, visitId, JSONObject().put("caseSheet", sheet))
                                    visit = JSONObject(v.toString()).put("caseSheet", sheet)
                                } catch (e: Exception) { errs["sheet"] = e.message ?: "Couldn't build the case sheet" }
                                busy["sheet"] = false
                            }
                        }
                        ErrorText(errs["sheet"])
                    } else {
                        Label("Chief complaints")
                        cs.objs("chiefComplaints").forEachIndexed { i, c -> Text("${i + 1}. ${c.str("complaint")}${if (c.str("duration").isNotBlank()) " — " + c.str("duration") else ""}", color = Ui.Text, fontWeight = FontWeight.SemiBold) }
                        if (cs.str("hpi").isNotBlank()) { Label("History of present illness"); Text(cs.str("hpi"), color = Ui.Text) }
                        val flags = cs.strs("redFlags")
                        if (flags.isNotEmpty()) Text("Red flags: " + flags.joinToString("; "), color = Ui.Red, fontWeight = FontWeight.SemiBold)
                        val past = cs.obj("past"); val h = cs.obj("habits")
                        Kv("Past illness", past.str("medical")); Kv("Surgery", past.str("surgical")); Kv("Transfusion", past.str("transfusion"))
                        Kv("Current drugs", past.str("drugs")); Kv("Drug allergy", past.str("allergies"))
                        Kv("Smoking", h.str("smoking")); Kv("Alcohol", h.str("alcohol")); Kv("Tobacco", h.str("tobacco"))
                        Kv("Diet", h.str("diet")); Kv("Sleep", h.str("sleep")); Kv("Appetite / bowel / bladder", h.str("appetiteBowelBladder"))
                        Kv("Menstrual / obstetric", cs.str("menstrualObstetric")); Kv("Family history", cs.str("family"))
                    }
                    var showQa by remember { mutableStateOf(false) }
                    TextButton(onClick = { showQa = !showQa }) { Text(if (showQa) "Hide patient's own answers" else "Show patient's own answers (${v.objs("qa").size})") }
                    if (showQa) v.objs("qa").forEach { Text("${it.str("q")} — ${it.str("a")}", color = Ui.Muted, fontSize = 13.sp) }
                }
            }

            // 2. Vitals and examination
            item {
                Section("2", "Vitals and examination") {
                    val fields = listOf("bp" to "BP (mmHg)", "pulse" to "Pulse (/min)", "temp" to "Temp (°F)", "spo2" to "SpO₂ (%)", "rr" to "Resp. rate", "rbs" to "RBS (mg/dL)", "weight" to "Weight (kg)")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        fields.forEach { (k, l) ->
                            OutlinedTextField(vitals[k].orEmpty(), { vitals[k] = it.take(12) }, label = { Text(l, fontSize = 12.sp) }, singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = if (k == "bp") KeyboardType.Text else KeyboardType.Decimal), modifier = Modifier.width(150.dp))
                        }
                    }
                    OutlinedTextField(exam, { exam = it }, label = { Text("Examination findings") }, minLines = 3, modifier = Modifier.fillMaxWidth())
                }
            }

            // 3. AI: investigations and diagnosis
            item {
                Section("3", "Investigations and diagnosis") {
                    AiButton(if (assessment == null) "Suggest investigations and diagnosis" else "Suggest again", busy["assess"] == true) {
                        runAi("assess", {
                            "You are a clinical decision-support assistant for a qualified doctor (general surgery / general medicine OPD in India). The doctor makes every decision; give reasoning they can check.\n${caseText(false)}\nSuggest focused investigations, a ranked differential diagnosis and a provisional diagnosis, based on this case; say when a key fact is missing. Prefer investigations available in a typical Indian clinic or district hospital.\nReply with ONLY this JSON: {\"summary\":\"one-line clinical summary\",\"redFlags\":[\"\"],\"examineFor\":[\"signs to check\"],\"differentials\":[{\"diagnosis\":\"\",\"likelihood\":\"high|moderate|low\",\"for\":[\"\"],\"against\":[\"\"]}],\"provisional\":{\"diagnosis\":\"\",\"justification\":\"\"},\"investigations\":[{\"name\":\"\",\"priority\":\"essential|optional\",\"reason\":\"\"}]}\nGive 3-5 differentials, most likely first."
                        }) { r ->
                            assessment = r
                            r.objs("investigations").filter { it.str("priority") == "essential" }.forEach { if (it.str("name") !in ordered) ordered.add(it.str("name")) }
                        }
                    }
                    ErrorText(errs["assess"])
                    assessment?.let { a ->
                        AiBox {
                            if (a.str("summary").isNotBlank()) Text(a.str("summary"), color = Ui.Text, fontWeight = FontWeight.SemiBold)
                            if (a.strs("redFlags").isNotEmpty()) Text("Red flags: " + a.strs("redFlags").joinToString("; "), color = Ui.Red)
                            if (a.strs("examineFor").isNotEmpty()) Text("Look for: " + a.strs("examineFor").joinToString("; "), color = Ui.Teal, fontSize = 14.sp)
                            a.obj("provisional")?.let { pv ->
                                AiItem {
                                    Label("Provisional diagnosis")
                                    Text(pv.str("diagnosis"), color = Ui.Text, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                                    Why(pv.str("justification"))
                                    OutlinedButton(onClick = { provisional = pv.str("diagnosis") }) { Text("Use this") }
                                }
                            }
                            Label("Differential diagnosis")
                            a.objs("differentials").forEach { d ->
                                AiItem {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(d.str("diagnosis"), color = Ui.Text, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                                        Pill(d.str("likelihood"), when (d.str("likelihood")) { "high" -> Ui.Red; "moderate" -> Ui.Amber; else -> Ui.Muted })
                                    }
                                    if (d.strs("for").isNotEmpty()) Text("For: " + d.strs("for").joinToString("; "), color = Ui.Green, fontSize = 13.sp)
                                    if (d.strs("against").isNotEmpty()) Text("Against: " + d.strs("against").joinToString("; "), color = Ui.Red, fontSize = 13.sp)
                                    TextButton(onClick = { provisional = d.str("diagnosis") }) { Text("Use as provisional") }
                                }
                            }
                            Label("Suggested investigations · tick to order")
                            a.objs("investigations").forEach { inv ->
                                val n = inv.str("name")
                                Row(verticalAlignment = Alignment.Top, modifier = Modifier.clickable { if (n in ordered) ordered.remove(n) else ordered.add(n) }) {
                                    Checkbox(n in ordered, { if (it) ordered.add(n) else ordered.remove(n) })
                                    Column(Modifier.padding(top = 10.dp)) {
                                        Text("$n  ·  ${inv.str("priority")}", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                                        Text(inv.str("reason"), color = Ui.Muted, fontSize = 13.sp)
                                    }
                                }
                            }
                        }
                    }
                    OutlinedTextField(provisional, { provisional = it }, label = { Text("Provisional diagnosis (yours)") }, modifier = Modifier.fillMaxWidth())
                }
            }

            // 4. Results
            item {
                Section("4", "Investigation results") {
                    val sent = orders.map { it.str("test").lowercase() }.toSet()
                    val unsent = ordered.filter { it.lowercase() !in sent }
                    if (ordered.isNotEmpty()) Text("Ordered: " + ordered.joinToString(", "), color = Ui.Muted, fontSize = 13.sp)
                    var sending by remember { mutableStateOf(false) }
                    if (unsent.isNotEmpty()) Button(
                        enabled = !sending,
                        onClick = {
                            sending = true
                            scope.launch {
                                try {
                                    val r = api.call("/api/orders/create", JSONObject().put("session", session).put("visitId", visitId).put("tests", JSONArray(unsent)))
                                    Toast.makeText(context, "Sent ${r.optInt("created")} test(s) to the lab and diagnostics", Toast.LENGTH_SHORT).show()
                                    ordersTick++
                                } catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't send", Toast.LENGTH_LONG).show() }
                                sending = false
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(if (sending) "Sending…" else "Send ${unsent.size} test(s) to lab & diagnostics") }
                    if (orders.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                        Label("Orders and reports"); Spacer(Modifier.weight(1f))
                        TextButton(onClick = { ordersTick++ }) { Text("Refresh") }
                    }
                    orders.forEach { o ->
                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Ui.CardHigh).padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("${o.str("test")}  ·  ${o.str("modality")}", color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, modifier = Modifier.weight(1f))
                                Pill(orderStatusLabel(o.str("status")), if (o.str("status") == "reported") Ui.Green else Ui.Amber)
                            }
                            if (o.str("status") == "reported") {
                                if (o.str("result").isNotBlank()) Text(o.str("result"), color = Ui.Text, fontSize = 13.sp)
                                if (o.str("impression").isNotBlank()) Text("Impression: " + o.str("impression"), color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                                TextButton(onClick = {
                                    val line = "${o.str("test")}: ${o.str("result")}${if (o.str("impression").isNotBlank()) " Impression: " + o.str("impression") else ""}"
                                    resultsText = if (resultsText.isBlank()) line else resultsText.trimEnd() + "\n" + line
                                }) { Text("Copy into results") }
                            }
                        }
                    }
                    OutlinedTextField(resultsText, { resultsText = it }, label = { Text("Type the results (e.g. Hb 12.1, TC 14,800, USG: …)") }, minLines = 3, modifier = Modifier.fillMaxWidth())
                    AiButton("Analyse results", busy["analyse"] == true) {
                        if (resultsText.isBlank()) { errs["analyse"] = "Type the results first." }
                        else runAi("analyse", {
                            "You are a clinical decision-support assistant for a qualified doctor in India. Interpret the investigation results together with the history and examination.\n${caseText(true)}\nReply with ONLY this JSON: {\"findings\":[{\"test\":\"\",\"value\":\"value with unit\",\"flag\":\"normal|high|low|abnormal|critical\",\"meaning\":\"\"}],\"diagnosis\":\"most likely diagnosis now\",\"confidence\":\"high|moderate|low\",\"justification\":\"\",\"furtherTests\":[{\"name\":\"\",\"reason\":\"\"}]}"
                        }) { analysis = it }
                    }
                    ErrorText(errs["analyse"])
                    analysis?.let { an ->
                        AiBox {
                            an.objs("findings").forEach { f ->
                                val bad = f.str("flag") != "normal"
                                Text("${f.str("test")}: ${f.str("value")} — ${f.str("flag")}", color = if (bad) Ui.Red else Ui.Green, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                                if (f.str("meaning").isNotBlank()) Text(f.str("meaning"), color = Ui.Muted, fontSize = 13.sp)
                            }
                            if (an.str("diagnosis").isNotBlank()) AiItem {
                                Label("Diagnosis with results · confidence ${an.str("confidence")}")
                                Text(an.str("diagnosis"), color = Ui.Text, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                                Why(an.str("justification"))
                                OutlinedButton(onClick = { finalDx = an.str("diagnosis") }) { Text("Use as final diagnosis") }
                            }
                            if (an.objs("furtherTests").isNotEmpty()) Text("Further tests: " + an.objs("furtherTests").joinToString("; ") { it.str("name") + " (" + it.str("reason") + ")" }, color = Ui.Muted, fontSize = 13.sp)
                        }
                    }
                    OutlinedTextField(finalDx, { finalDx = it }, label = { Text("Final diagnosis") }, modifier = Modifier.fillMaxWidth())
                }
            }

            // 5. Treatment suggestions
            item {
                Section("5", "Treatment suggestions") {
                    AiButton(if (treatment == null) "Suggest treatment" else "Suggest again", busy["treat"] == true) {
                        runAi("treat", {
                            "You are a clinical decision-support assistant for a qualified doctor in an Indian OPD (general surgery and general medicine). Suggest management for the doctor to review, edit or reject.\n${caseText(true)}\nInstructions:\n- Decide whether management is medical, surgical, or both. For surgery give the procedure, indication, urgency and pre-op work-up.\n- Prescribe by generic name with adult doses used in India (adjust for age, weight, kidney or liver disease and pregnancy). Check allergies and current drugs; list interactions or contraindications under cautions.\n- Frequency in Indian notation (1-0-1 = morning-afternoon-night). timing is one of: After food, Before food, With food, Empty stomach, At bedtime, As needed.\n- Advice must fit THIS patient's history (e.g. stop smoking only if they smoke; diet matching the diagnosis). Include warning signs to return early.\n- Suggest physiotherapy or a psychologist only when there is a reason. Give a review interval in days.\n- Prefer medicines in the clinic pharmacy stock below when clinically appropriate; you may suggest others when better.\nClinic pharmacy stock (generic strength (form) | units):\n${stockText.ifBlank { "(not available)" }}\nReply with ONLY this JSON: {\"approach\":\"medical|surgical|both\",\"surgical\":{\"recommended\":false,\"procedure\":\"\",\"indication\":\"\",\"urgency\":\"emergency|urgent|elective\",\"preop\":[\"\"],\"justification\":\"\"},\"medicines\":[{\"generic\":\"\",\"form\":\"Tab\",\"strength\":\"\",\"dose\":\"1 tab\",\"frequency\":\"1-0-1\",\"timing\":\"After food\",\"duration\":\"5 days\",\"instructions\":\"\",\"reason\":\"\"}],\"cautions\":[\"\"],\"advice\":[{\"text\":\"\",\"why\":\"\"}],\"physio\":{\"needed\":false,\"reason\":\"\"},\"psych\":{\"needed\":false,\"reason\":\"\"},\"reviewInDays\":7,\"reviewReason\":\"\"}"
                        }) { r -> treatment = r; if (finalDx.isBlank() && provisional.isBlank()) finalDx = analysis.str("diagnosis") }
                    }
                    ErrorText(errs["treat"])
                    treatment?.let { tr ->
                        AiBox {
                            Text("Approach: ${tr.str("approach")}", color = Ui.Teal, fontWeight = FontWeight.SemiBold)
                            val s = tr.obj("surgical")
                            if (s?.optBoolean("recommended") == true) AiItem {
                                Label("Surgical management · ${s.str("urgency")}")
                                Text(s.str("procedure"), color = Ui.Text, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                                if (s.str("indication").isNotBlank()) Text("Indication: " + s.str("indication"), color = Ui.Text, fontSize = 14.sp)
                                if (s.strs("preop").isNotEmpty()) Text("Pre-op: " + s.strs("preop").joinToString("; "), color = Ui.Text, fontSize = 14.sp)
                                Why(s.str("justification"))
                                OutlinedButton(onClick = { surgery = "${s.str("procedure")} (${s.str("urgency")})" }) { Text("Add to plan") }
                            }
                            if (tr.strs("cautions").isNotEmpty()) Text("Cautions: " + tr.strs("cautions").joinToString("; "), color = Ui.Amber, fontSize = 14.sp)
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Label("Medicines"); Spacer(Modifier.weight(1f))
                                TextButton(onClick = { tr.objs("medicines").forEach { m -> if (rx.none { it.generic == m.str("generic") }) rx.add(aiDrug(m)) } }) { Text("Add all") }
                            }
                            tr.objs("medicines").forEach { m ->
                                AiItem {
                                    Text("${m.str("form")} ${m.str("generic")} ${m.str("strength")}", color = Ui.Text, fontWeight = FontWeight.SemiBold)
                                    Text("${m.str("dose")} · ${m.str("frequency")} · ${m.str("timing")} · ${m.str("duration")}", color = Ui.Text, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
                                    if (m.str("instructions").isNotBlank()) Text(m.str("instructions"), color = Ui.Text, fontSize = 13.sp)
                                    Why(m.str("reason"))
                                    if (rx.any { it.generic == m.str("generic") }) Pill("On prescription", Ui.Green)
                                    else OutlinedButton(onClick = { rx.add(aiDrug(m)) }) { Text("Add to prescription") }
                                }
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Label("Advice"); Spacer(Modifier.weight(1f))
                                TextButton(onClick = { tr.objs("advice").forEach { if (it.str("text") !in advice) advice.add(it.str("text")) } }) { Text("Add all") }
                            }
                            tr.objs("advice").forEach { a ->
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(1f)) { Text(a.str("text"), color = Ui.Text, fontSize = 14.sp); Why(a.str("why")) }
                                    if (a.str("text") in advice) Pill("Added", Ui.Green) else TextButton(onClick = { advice.add(a.str("text")) }) { Text("Add") }
                                }
                            }
                            tr.obj("physio")?.takeIf { it.optBoolean("needed") }?.let { ph ->
                                AiItem { Label("Physiotherapy"); Why(ph.str("reason")); OutlinedButton(onClick = { physio = ph.str("reason").ifBlank { "Advised" } }) { Text("Add referral") } }
                            }
                            tr.obj("psych")?.takeIf { it.optBoolean("needed") }?.let { ps ->
                                AiItem { Label("Psychologist consultation"); Why(ps.str("reason")); OutlinedButton(onClick = { psych = ps.str("reason").ifBlank { "Advised" } }) { Text("Add referral") } }
                            }
                            val days = tr.optInt("reviewInDays", 0)
                            if (days > 0) AiItem {
                                Text("Review in $days days", color = Ui.Text, fontWeight = FontWeight.SemiBold); Why(tr.str("reviewReason"))
                                OutlinedButton(onClick = { review = LocalDate.now().plusDays(days.toLong()).toString(); reviewNote = tr.str("reviewReason") }) { Text("Set review date") }
                            }
                        }
                    }
                }
            }

            // 6. Prescription
            item {
                Section("6", "Prescription") {
                    if (surgery.isNotBlank()) Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Surgical plan: $surgery", color = Ui.Teal, modifier = Modifier.weight(1f)); IconButton(onClick = { surgery = "" }) { Icon(Icons.Filled.Close, "Remove", tint = Ui.Red) }
                    }
                    if (rx.isEmpty()) Text("No medicines yet. Add from the suggestions above or type a name below.", color = Ui.Muted)
                    rx.forEachIndexed { i, r -> RxEditor(r, inStock(r.generic), onChange = { rx[i] = it }, onDelete = { rx.removeAt(i) }) }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(newDrug, { newDrug = it }, label = { Text("Add a medicine (generic name)") }, singleLine = true, modifier = Modifier.weight(1f))
                        TextButton(onClick = { if (newDrug.isNotBlank()) { rx.add(RxItem(newDrug.trim())); newDrug = "" } }) { Text("Add") }
                    }
                    Label("Advice to patient")
                    advice.forEachIndexed { i, a ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("• $a", color = Ui.Text, modifier = Modifier.weight(1f), fontSize = 14.sp)
                            IconButton(onClick = { advice.removeAt(i) }) { Icon(Icons.Filled.Close, "Remove advice", tint = Ui.Red) }
                        }
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        QUICK_ADVICE.filter { it !in advice }.forEach { q -> Choice("+ $q", false) { advice.add(q) } }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(newAdvice, { newAdvice = it }, label = { Text("Other advice") }, singleLine = true, modifier = Modifier.weight(1f))
                        TextButton(onClick = { if (newAdvice.isNotBlank()) { advice.add(newAdvice.trim()); newAdvice = "" } }) { Text("Add") }
                    }
                    OutlinedTextField(physio, { physio = it }, label = { Text("Physiotherapy referral (leave empty if none)") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(psych, { psych = it }, label = { Text("Psychologist referral (leave empty if none)") }, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(review, { review = it.take(10) }, label = { Text("Review (YYYY-MM-DD)") }, singleLine = true, modifier = Modifier.weight(1f))
                        OutlinedTextField(reviewNote, { reviewNote = it }, label = { Text("Review note") }, singleLine = true, modifier = Modifier.weight(1.4f))
                    }
                    Button(onClick = { save("sent", withRx = true) }, modifier = Modifier.fillMaxWidth()) { Text("Finish and save prescription") }
                    saveMsg?.let { Text(it, color = if (it.startsWith("Prescription") || it == "Saved.") Ui.Green else Ui.Red, fontWeight = FontWeight.SemiBold) }
                    OutlinedButton(onClick = {
                        val text = prescriptionText(vm.prefs.doctorName, p.str("name"), p.str("age"), p.str("sex"), finalDx.ifBlank { provisional }, surgery, rx, advice, physio, psych, review, reviewNote, p.str("id"))
                        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "Share prescription"))
                    }, modifier = Modifier.fillMaxWidth()) { Text("Share prescription (WhatsApp, SMS…)") }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = {
                            Printer.print(context, "Prescription ${p.str("name")}", prescriptionHtml(vm.prefs, p ?: JSONObject(), finalDx.ifBlank { provisional }, surgery, rx, advice, physio, psych, review, reviewNote))
                        }, modifier = Modifier.weight(1f)) { Text("Print / PDF") }
                        OutlinedButton(onClick = { letterOpen = true }, modifier = Modifier.weight(1f)) { Text("Certificate / letter") }
                    }
                    Text("AI suggestions are for the doctor to verify. Nothing reaches the prescription until you add it.", color = Ui.Muted, fontSize = 12.sp)
                }
            }
        }
    }
    if (letterOpen) visit?.let { v ->
        val summary = buildString {
            val cs = v.optJSONObject("caseSheet")
            cs.objs("chiefComplaints").joinToString("; ") { it.str("complaint") + if (it.str("duration").isNotBlank()) " for " + it.str("duration") else "" }
                .takeIf { it.isNotBlank() }?.let { append("Presenting complaint: $it. ") }
            cs.str("hpi").takeIf { it.isNotBlank() }?.let { append("$it ") }
            (finalDx.ifBlank { provisional }).takeIf { it.isNotBlank() }?.let { append("Diagnosis: $it. ") }
            if (rx.isNotEmpty()) append("Treatment given: " + rx.joinToString(", ") { it.line() } + ".")
        }
        LetterDialog(vm, session, v.optJSONObject("patient") ?: JSONObject(), visitId, finalDx.ifBlank { provisional }, summary, onDismiss = { letterOpen = false })
    }
}

private fun aiDrug(m: JSONObject) = RxItem(
    m.str("generic"), m.str("form").ifBlank { "Tab" }, m.str("strength"), m.str("dose"), m.str("frequency"),
    m.str("timing").ifBlank { "After food" }, m.str("duration"), m.str("instructions"), fromAi = true,
)

private fun prescriptionText(
    doctor: String, name: String, age: String, sex: String, dx: String, surgery: String, rx: List<RxItem>,
    advice: List<String>, physio: String, psych: String, review: String, reviewNote: String, pid: String = "",
) = buildString {
    append("Rx Clinic\n$doctor\n\nPatient: $name, $age y, $sex${if (pid.isNotBlank()) "  (ID $pid)" else ""}\nDate: ${LocalDate.now()}\n")
    if (dx.isNotBlank()) append("Diagnosis: $dx\n")
    if (surgery.isNotBlank()) append("Plan: $surgery\n")
    append("\nRx\n")
    rx.forEachIndexed { i, r -> append("${i + 1}. ${r.line()} — ${r.dose}, ${r.frequency}, ${r.timing}, ${r.duration}${if (r.instructions.isNotBlank()) ". " + r.instructions else ""}\n") }
    if (advice.isNotEmpty()) { append("\nAdvice:\n"); advice.forEach { append("- $it\n") } }
    if (physio.isNotBlank()) append("Physiotherapy: $physio\n")
    if (psych.isNotBlank()) append("Psychologist: $psych\n")
    if (review.isNotBlank()) append("\nReview on: $review${if (reviewNote.isNotBlank()) " — $reviewNote" else ""}\n")
}

// ---------- small pieces ----------

@Composable
private fun Section(step: String, title: String, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Ui.Card).border(1.dp, Ui.Line, RoundedCornerShape(16.dp)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(step, color = Ui.Teal, fontFamily = FontFamily.Monospace, modifier = Modifier.width(22.dp))
            Text(title, color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, fontFamily = FontFamily.Serif)
        }
        content()
    }
}

@Composable
private fun AiBox(content: @Composable () -> Unit) {
    val ai = Ui.Ai
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Ui.AiSoft).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("AI suggestion · verify before acting", color = ai, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
        content()
    }
}

@Composable
private fun AiItem(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Ui.Card).border(1.dp, Ui.Line, RoundedCornerShape(10.dp)).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) { content() }
}

@Composable
private fun AiButton(label: String, busy: Boolean, onClick: () -> Unit) {
    if (busy) Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(color = Ui.Ai, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(10.dp)); Text("Thinking… usually 10–40 seconds", color = Ui.Ai)
    } else Button(onClick = onClick, colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4447A3))) { Text(label, color = Color.White) }
}

@Composable
private fun Label(text: String) = Text(text.uppercase(), color = Ui.Muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp)

@Composable
private fun Why(text: String) { if (text.isNotBlank()) Text("Why: $text", color = Ui.Muted, fontSize = 13.sp) }

@Composable
private fun Kv(k: String, v: String) {
    if (v.isBlank()) return
    Row { Text(k, color = Ui.Muted, fontSize = 14.sp, modifier = Modifier.width(130.dp)); Text(v, color = Ui.Text, fontSize = 14.sp) }
}

@Composable
private fun RxEditor(r: RxItem, inStock: Boolean?, onChange: (RxItem) -> Unit, onDelete: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Ui.CardHigh).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(r.line(), color = Ui.Text, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (inStock == true) Pill("In pharmacy", Ui.Green) else if (inStock == false) Pill("Not in pharmacy", Ui.Amber)
            if (r.fromAi) { Spacer(Modifier.width(4.dp)); Pill("AI", Ui.Ai) }
            IconButton(onClick = onDelete) { Icon(Icons.Filled.Close, "Delete medicine", tint = Ui.Red) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedTextField(r.form, { onChange(r.copy(form = it)) }, label = { Text("Form", fontSize = 11.sp) }, singleLine = true, modifier = Modifier.weight(1f))
            OutlinedTextField(r.generic, { onChange(r.copy(generic = it)) }, label = { Text("Generic", fontSize = 11.sp) }, singleLine = true, modifier = Modifier.weight(2f))
            OutlinedTextField(r.strength, { onChange(r.copy(strength = it)) }, label = { Text("Strength", fontSize = 11.sp) }, singleLine = true, modifier = Modifier.weight(1.3f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedTextField(r.dose, { onChange(r.copy(dose = it)) }, label = { Text("Dose", fontSize = 11.sp) }, singleLine = true, modifier = Modifier.weight(1f))
            OutlinedTextField(r.frequency, { onChange(r.copy(frequency = it)) }, label = { Text("1-0-1", fontSize = 11.sp) }, singleLine = true, modifier = Modifier.weight(1f))
            OutlinedTextField(r.duration, { onChange(r.copy(duration = it)) }, label = { Text("Duration", fontSize = 11.sp) }, singleLine = true, modifier = Modifier.weight(1f))
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            TIMINGS.forEach { t -> Choice(t, r.timing == t) { onChange(r.copy(timing = t)) } }
        }
        OutlinedTextField(r.instructions, { onChange(r.copy(instructions = it)) }, label = { Text("Instructions", fontSize = 11.sp) }, singleLine = true, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
internal fun PreviousVisits(history: List<JSONObject>) {
    var open by remember { mutableStateOf(false) }
    BoxCard {
        Row(Modifier.fillMaxWidth().clickable { open = !open }, verticalAlignment = Alignment.CenterVertically) {
            Text("Previous visits (${history.size})", color = Ui.Text, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(if (open) "Hide" else "Show", color = Ui.Teal, fontSize = 13.sp)
        }
        if (open) history.forEach { h -> VisitSummaryCard(h) }
    }
}

@Composable
internal fun VisitSummaryCard(h: JSONObject) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(dayLabel(h.str("date")) + (if (h.str("doctor").isNotBlank()) " · " + h.str("doctor") else ""), color = Ui.Muted, fontSize = 12.sp)
        if (h.str("diagnosis").isNotBlank()) Text(h.str("diagnosis"), color = Ui.Text, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        else if (h.str("complaint").isNotBlank()) Text(h.str("complaint"), color = Ui.Text, fontSize = 14.sp)
        h.obj("rx").objs("items").forEach { r ->
            Text("• ${r.str("form")} ${r.str("generic")} ${r.str("strength")}  ${r.str("dose")} ${r.str("frequency")} ${r.str("timing")} × ${r.str("duration")}".replace(Regex(" +"), " "),
                color = Ui.Text, fontSize = 13.sp)
        }
        h.objs("reports").filter { it.str("status") == "reported" }.forEach { o ->
            Text("${o.str("test")}: " + o.str("impression").ifBlank { o.str("result") }, color = Ui.Text, fontSize = 13.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
    }
}
