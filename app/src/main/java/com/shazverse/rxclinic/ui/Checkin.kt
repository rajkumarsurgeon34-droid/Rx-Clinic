@file:OptIn(ExperimentalLayoutApi::class)

package com.shazverse.rxclinic.ui

import android.speech.tts.TextToSpeech
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.shazverse.rxclinic.Api
import com.shazverse.rxclinic.call.CallViewModel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.Locale

private val LANGS = listOf("en" to "English", "ta" to "தமிழ்", "hi" to "हिन्दी")
private val LOCALES = mapOf("en" to Locale("en", "IN"), "ta" to Locale("ta", "IN"), "hi" to Locale("hi", "IN"))

private val T: Map<String, Map<String, String>> = mapOf(
    "en" to mapOf(
        "welcome" to "Welcome. A few questions before you see the doctor",
        "sub" to "Your answers go only to the doctor treating you today.",
        "name" to "Full name", "age" to "Age", "phone" to "Mobile number (optional)",
        "Male" to "Male", "Female" to "Female", "Other" to "Other",
        "consent" to "I agree that my answers are stored for the doctor to see.",
        "start" to "Start", "type" to "Or type your answer", "next" to "Next",
        "thinking" to "Preparing the next question…", "saving" to "Preparing your details for the doctor…",
        "thanks" to "Thank you. Your details have been sent to the doctor. Please wait for your token to be called.",
        "pid" to "Patient ID, if you have one (e.g. RX100001)", "yourid" to "Your Patient ID",
        "newid" to "New Patient ID made for you. Keep it for your next visit.", "keepid" to "Show this ID at your next visit.",
        "token" to "Your token", "another" to "Next patient", "urgent" to "Please tell the staff at the desk right now.",
        "need" to "Please fill in name, age and sex, and tick the box.", "retry" to "Try again", "q" to "Question",
        "voice" to "Read questions aloud", "novoice" to "No voice for this language on this phone. Questions will show as text.",
    ),
    "ta" to mapOf(
        "welcome" to "வணக்கம். மருத்துவரைப் பார்க்கும் முன் சில கேள்விகள்",
        "sub" to "உங்கள் பதில்கள் இன்று உங்களைப் பார்க்கும் மருத்துவருக்கு மட்டுமே செல்லும்.",
        "name" to "முழுப் பெயர்", "age" to "வயது", "phone" to "கைபேசி எண் (விருப்பம்)",
        "Male" to "ஆண்", "Female" to "பெண்", "Other" to "மற்றவை",
        "consent" to "மருத்துவர் பார்ப்பதற்காக என் பதில்களைச் சேமிக்க ஒப்புக்கொள்கிறேன்.",
        "start" to "தொடங்கு", "type" to "அல்லது உங்கள் பதிலை எழுதுங்கள்", "next" to "அடுத்து",
        "thinking" to "அடுத்த கேள்வி தயாராகிறது…", "saving" to "மருத்துவருக்காக உங்கள் விவரங்கள் தயாராகின்றன…",
        "thanks" to "நன்றி. உங்கள் விவரங்கள் மருத்துவருக்கு அனுப்பப்பட்டன. உங்கள் டோக்கன் அழைக்கப்படும் வரை காத்திருங்கள்.",
        "pid" to "நோயாளி அடையாள எண் (இருந்தால்), எ.கா. RX100001", "yourid" to "உங்கள் நோயாளி அடையாள எண்",
        "newid" to "உங்களுக்கு புதிய நோயாளி அடையாள எண் உருவாக்கப்பட்டது. அடுத்த முறை வரும்போது வைத்திருங்கள்.", "keepid" to "அடுத்த முறை இந்த எண்ணைக் காட்டுங்கள்.",
        "token" to "உங்கள் டோக்கன்", "another" to "அடுத்த நோயாளி", "urgent" to "உடனே வரவேற்பு மேசையில் உள்ள ஊழியரிடம் சொல்லுங்கள்.",
        "need" to "பெயர், வயது, பாலினம் நிரப்பி, பெட்டியைத் தேர்வு செய்யுங்கள்.", "retry" to "மீண்டும் முயற்சி", "q" to "கேள்வி",
        "voice" to "கேள்விகளைச் சத்தமாகப் படி", "novoice" to "இந்தக் கைபேசியில் தமிழ் குரல் இல்லை. கேள்விகள் எழுத்தில் காட்டப்படும்.",
    ),
    "hi" to mapOf(
        "welcome" to "नमस्ते। डॉक्टर से मिलने से पहले कुछ सवाल",
        "sub" to "आपके जवाब सिर्फ़ आज आपका इलाज करने वाले डॉक्टर को जाएँगे।",
        "name" to "पूरा नाम", "age" to "उम्र", "phone" to "मोबाइल नंबर (वैकल्पिक)",
        "Male" to "पुरुष", "Female" to "महिला", "Other" to "अन्य",
        "consent" to "मैं सहमत हूँ कि मेरे जवाब डॉक्टर के देखने के लिए सहेजे जाएँ।",
        "start" to "शुरू करें", "type" to "या अपना जवाब लिखें", "next" to "आगे",
        "thinking" to "अगला सवाल तैयार हो रहा है…", "saving" to "डॉक्टर के लिए आपकी जानकारी तैयार हो रही है…",
        "thanks" to "धन्यवाद। आपकी जानकारी डॉक्टर को भेज दी गई है। अपना टोकन बुलाए जाने तक इंतज़ार करें।",
        "pid" to "मरीज़ आईडी, अगर है (जैसे RX100001)", "yourid" to "आपकी मरीज़ आईडी",
        "newid" to "आपके लिए नई मरीज़ आईडी बनाई गई है। अगली बार के लिए संभाल कर रखें।", "keepid" to "अगली बार यह आईडी दिखाएँ।",
        "token" to "आपका टोकन", "another" to "अगला मरीज़", "urgent" to "कृपया अभी डेस्क पर स्टाफ़ को बताएँ।",
        "need" to "नाम, उम्र और लिंग भरें, और बॉक्स पर टिक करें।", "retry" to "फिर से कोशिश करें", "q" to "सवाल",
        "voice" to "सवाल पढ़कर सुनाएँ", "novoice" to "इस फ़ोन पर हिन्दी आवाज़ नहीं है। सवाल लिखकर दिखेंगे।",
    ),
)

private class Question(val text: String, val options: List<String>, val multi: Boolean, val urgent: Boolean)

/** Patient check-in: the AI interviews the patient one question at a time, then sends the case sheet to the doctor. */
@Composable
fun CheckinScreen(vm: CallViewModel, onBack: () -> Unit) {
    val context = LocalContext.current
    val api = remember { Api(vm.prefs.serverUrl) }
    val scope = rememberCoroutineScope()

    var lang by remember { mutableStateOf("en") }
    fun t(k: String) = T[lang]?.get(k) ?: T["en"]!![k] ?: k

    var stage by remember { mutableStateOf("start") } // start, chat, saving, done
    var name by remember { mutableStateOf(vm.prefs.patientName) }
    var age by remember { mutableStateOf("") }
    var sex by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var pid by remember { mutableStateOf("") }
    var givenId by remember { mutableStateOf("") }
    var newPatient by remember { mutableStateOf(false) }
    var consent by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var urgent by remember { mutableStateOf(false) }
    var token by remember { mutableStateOf(0) }
    var closing by remember { mutableStateOf("") }
    var current by remember { mutableStateOf<Question?>(null) }
    val selected = remember { mutableStateListOf<Int>() }
    var free by remember { mutableStateOf("") }
    val turns = remember { mutableStateListOf<Pair<String, String>>() }
    val qa = remember { mutableStateListOf<Pair<String, String>>() }

    // Voice: Android's own text-to-speech, in the patient's language
    var voiceOn by remember { mutableStateOf(true) }
    var ttsReady by remember { mutableStateOf(false) }
    var voiceMissing by remember { mutableStateOf(false) }
    val tts = remember { arrayOfNulls<TextToSpeech>(1) }
    DisposableEffect(Unit) {
        tts[0] = TextToSpeech(context) { status -> ttsReady = status == TextToSpeech.SUCCESS }
        onDispose { tts[0]?.stop(); tts[0]?.shutdown() }
    }
    fun speak(text: String) {
        val engine = tts[0] ?: return
        if (!ttsReady || !voiceOn) return
        val r = engine.setLanguage(LOCALES[lang] ?: Locale.ENGLISH)
        voiceMissing = r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED
        if (!voiceMissing) engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "q")
    }

    fun finish(closingLine: String) {
        stage = "saving"; closing = closingLine
        scope.launch {
            try {
                val r = api.checkinFinish(name.trim(), age, sex, phone, lang, qa.toList(), urgent, givenId.trim(), vm.prefs.patientSession)
                token = r.optInt("token"); pid = r.optString("patientId"); newPatient = r.optBoolean("newPatient")
                stage = "done"
                speak(closingLine.ifBlank { t("thanks") })
            } catch (e: Exception) {
                err = e.message; stage = "chat"
            }
        }
    }

    fun nextQuestion() {
        busy = true; err = null; current = null; selected.clear(); free = ""
        scope.launch {
            try {
                val r: JSONObject = api.checkinNext(lang, age, sex, turns.toList())
                if (r.optBoolean("done") || qa.size >= 26) {
                    busy = false; finish(r.optString("closing")); return@launch
                }
                val opts = r.optJSONArray("options")
                val q = Question(
                    r.optString("question").trim(),
                    (0 until (opts?.length() ?: 0)).map { opts!!.optString(it) }.filter { it.isNotBlank() }.take(8),
                    r.optBoolean("multi"), r.optBoolean("urgent"),
                )
                if (q.text.isBlank()) throw IllegalStateException("The question came back empty. Try again.")
                if (q.urgent) urgent = true
                turns.add("assistant" to r.toString())
                current = q
                speak(q.text + if (q.options.isNotEmpty()) ". " + q.options.joinToString(", ") else "")
            } catch (e: Exception) {
                err = e.message ?: "Couldn't get the next question"
            } finally { busy = false }
        }
    }

    fun answer(text: String) {
        val q = current ?: return
        val a = text.trim()
        if (a.isEmpty()) return
        tts[0]?.stop()
        qa.add(q.text to a)
        turns.add("user" to a)
        nextQuestion()
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar(if (stage == "chat") "${t("q")} ${qa.size + 1}" else "Check-in", onBack)
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (stage == "start" || stage == "chat") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    LANGS.forEach { (k, label) ->
                        Choice(label, lang == k, modifier = Modifier.weight(1f)) {
                            lang = k
                            if (stage == "chat" && current != null && !busy) {
                                turns.add("user" to "(The patient switched the language to ${label}. Ask the same question again in that language and continue in it.)")
                                nextQuestion()
                            }
                        }
                    }
                }
            }
            when (stage) {
                "start" -> {
                    Text(t("welcome"), color = Ui.Text, fontSize = 28.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Serif, lineHeight = 34.sp)
                    Text(t("sub"), color = Ui.Muted)
                    if (vm.prefs.patientSession != null) Text("Patient ID ${vm.prefs.patientId}", color = Ui.Teal, fontWeight = FontWeight.SemiBold)
                    else OutlinedTextField(givenId, { givenId = it.uppercase().filter { c -> c.isLetterOrDigit() }.take(12) }, label = { Text(t("pid")) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(name, { name = it.take(60) }, label = { Text(t("name")) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(age, { age = it.filter(Char::isDigit).take(3) }, label = { Text(t("age")) }, singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
                        OutlinedTextField(phone, { phone = it.filter(Char::isDigit).take(10) }, label = { Text(t("phone")) }, singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.weight(2f))
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("Male", "Female", "Other").forEach { s -> Choice(t(s), sex == s, modifier = Modifier.weight(1f)) { sex = s } }
                    }
                    Row(verticalAlignment = Alignment.Top, modifier = Modifier.clickable { consent = !consent }) {
                        Checkbox(consent, { consent = it })
                        Text(t("consent"), color = Ui.Text, modifier = Modifier.padding(top = 12.dp))
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(t("voice"), color = Ui.Text, modifier = Modifier.weight(1f))
                        Switch(voiceOn, { voiceOn = it })
                    }
                    ErrorText(err)
                    Button(
                        onClick = {
                            if (name.isBlank() || age.isBlank() || sex.isBlank() || !consent) { err = t("need") }
                            else { err = null; stage = "chat"; turns.clear(); qa.clear(); urgent = false; nextQuestion() }
                        },
                        modifier = Modifier.fillMaxWidth().height(54.dp),
                    ) { Text(t("start"), fontSize = 18.sp) }
                }
                "chat" -> {
                    qa.takeLast(2).forEach { (q, a) -> Text("$q — $a", color = Ui.Muted, fontSize = 13.sp) }
                    Column(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Ui.Card).border(1.dp, Ui.Line, RoundedCornerShape(18.dp)).padding(18.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        val q = current
                        when {
                            busy -> Row(verticalAlignment = Alignment.CenterVertically) {
                                CircularProgressIndicator(color = Ui.Teal, modifier = Modifier.size(22.dp))
                                Spacer(Modifier.width(12.dp)); Text(t("thinking"), color = Ui.Muted)
                            }
                            err != null && q == null -> {
                                ErrorText(err)
                                Button(onClick = { nextQuestion() }) { Text(t("retry")) }
                            }
                            q != null -> {
                                if (q.urgent) Text(t("urgent"), color = Ui.Red, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                                Row(verticalAlignment = Alignment.Top) {
                                    Text(q.text, color = Ui.Text, fontSize = 22.sp, fontFamily = FontFamily.Serif, lineHeight = 30.sp, modifier = Modifier.weight(1f))
                                    IconButton(onClick = { speak(q.text + ". " + q.options.joinToString(", ")) }) {
                                        Icon(Icons.AutoMirrored.Filled.VolumeUp, "Read aloud", tint = Ui.Teal)
                                    }
                                }
                                if (q.options.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    q.options.forEachIndexed { i, o ->
                                        Choice(o, i in selected) {
                                            if (q.multi) { if (i in selected) selected.remove(i) else selected.add(i) } else answer(o)
                                        }
                                    }
                                }
                                OutlinedTextField(free, { free = it.take(300) }, label = { Text(t("type")) }, modifier = Modifier.fillMaxWidth())
                                ErrorText(err)
                                Button(
                                    onClick = { answer((selected.sorted().map { q.options[it] } + free.trim()).filter { it.isNotBlank() }.joinToString(", ")) },
                                    enabled = selected.isNotEmpty() || free.isNotBlank(),
                                    modifier = Modifier.fillMaxWidth().height(50.dp),
                                ) { Text(t("next"), fontSize = 17.sp) }
                            }
                        }
                    }
                    if (voiceMissing && lang != "en") Text(t("novoice"), color = Ui.Muted, fontSize = 13.sp)
                }
                "saving" -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 24.dp)) {
                    CircularProgressIndicator(color = Ui.Teal, modifier = Modifier.size(24.dp))
                    Spacer(Modifier.width(12.dp)); Text(t("saving"), color = Ui.Text)
                }
                "done" -> Column(
                    Modifier.fillMaxWidth().padding(top = 24.dp).clip(RoundedCornerShape(18.dp)).background(Ui.Card).border(1.dp, Ui.Line, RoundedCornerShape(18.dp)).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(t("token"), color = Ui.Muted)
                    Text("$token", color = Ui.Teal, fontSize = 64.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                    Text(closing.ifBlank { t("thanks") }, color = Ui.Text, fontSize = 18.sp, textAlign = TextAlign.Center)
                    if (urgent) Text(t("urgent"), color = Ui.Red, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                    if (pid.isNotBlank()) {
                        Text(t("yourid"), color = Ui.Muted)
                        Text(pid, color = Ui.Text, fontSize = 30.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                        Text(t(if (newPatient) "newid" else "keepid"), color = Ui.Muted, fontSize = 14.sp, textAlign = TextAlign.Center)
                    }
                    Button(onClick = {
                        name = ""; age = ""; sex = ""; phone = ""; givenId = ""; pid = ""; consent = false; stage = "start"; token = 0; closing = ""
                        turns.clear(); qa.clear(); current = null; urgent = false
                    }) { Text(t("another")) }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
