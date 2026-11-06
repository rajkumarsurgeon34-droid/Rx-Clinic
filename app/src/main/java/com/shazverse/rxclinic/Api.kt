package com.shazverse.rxclinic

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class Appt(
    val id: String, val date: String, val time: String, val mode: String, val status: String,
    val name: String, val age: String, val sex: String, val phone: String, val reason: String,
    val lang: String, val code: String,
) {
    val isTele get() = mode == "tele"
    val isOpen get() = status !in setOf("completed", "cancelled", "no-show")

    companion object {
        fun from(o: JSONObject) = Appt(
            id = o.optString("id"), date = o.optString("date"), time = o.optString("time"),
            mode = o.optString("mode"), status = o.optString("status", "booked"),
            name = o.optString("name"), age = o.optString("age"), sex = o.optString("sex"),
            phone = o.optString("phone"), reason = o.optString("reason"), lang = o.optString("lang", "en"),
            code = o.optString("code"),
        )
    }
}

data class Slot(val time: String, val free: Boolean)
data class Session(val token: String, val role: String, val name: String, val username: String, val mustChange: Boolean, val clinicName: String, val qual: String = "", val reg: String = "", val clinic: JSONObject = JSONObject())
data class Joined(val url: String, val token: String, val identity: String, val role: String, val room: String, val title: String)

class ApiException(message: String) : Exception(message)

/** Talks to the Rx Clinic server (server/worker.js). */
class Api(private val baseUrl: String) {

    suspend fun slots(date: String): List<Slot> {
        val o = get("/api/slots?date=" + URLEncoder.encode(date, "UTF-8"))
        val arr = o.optJSONArray("slots") ?: JSONArray()
        return (0 until arr.length()).map { arr.getJSONObject(it).let { s -> Slot(s.optString("t"), s.optBoolean("free")) } }
    }

    suspend fun book(
        name: String, age: String, sex: String, phone: String, date: String, time: String,
        mode: String, reason: String, lang: String, patientSession: String? = null,
    ): Appt {
        val body = JSONObject()
            .put("name", name).put("age", age).put("sex", sex).put("phone", phone)
            .put("date", date).put("time", time).put("mode", mode).put("reason", reason).put("lang", lang)
        if (patientSession != null) body.put("patientSession", patientSession)
        val o = post("/api/book", body)
        return Appt.from(o.getJSONObject("appointment"))
    }

    suspend fun myAppointment(code: String, phone: String): Appt =
        Appt.from(post("/api/appt", JSONObject().put("code", code).put("phone", phone)).getJSONObject("appointment"))

    /** Staff sign-in with username and password; the server says which role the login has. */
    suspend fun login(username: String, password: String): Session {
        val o = post("/api/login", JSONObject().put("username", username.trim()).put("password", password))
        val u = o.optJSONObject("user") ?: JSONObject()
        val c = o.optJSONObject("clinic") ?: JSONObject()
        return Session(o.getString("session"), o.getString("role"), u.optString("name"), u.optString("username"), u.optBoolean("mustChange"), c.optString("name"), u.optString("qual"), u.optString("reg"), c)
    }

    /** Changes the signed-in person's password; returns the new session (old ones stop working). */
    suspend fun changePassword(session: String, old: String, new: String): String =
        post("/api/me/password", JSONObject().put("session", session).put("old", old).put("password", new)).getString("session")

    suspend fun dayAppointments(session: String, date: String): List<Appt> {
        val arr = post("/api/doctor/appointments", JSONObject().put("session", session).put("date", date))
            .optJSONArray("appointments") ?: JSONArray()
        return (0 until arr.length()).map { Appt.from(arr.getJSONObject(it)) }
    }

    suspend fun setStatus(session: String, id: String, status: String) {
        post("/api/doctor/status", JSONObject().put("session", session).put("id", id).put("status", status))
    }

    suspend fun doctorToken(session: String, apptId: String): Joined =
        joined(post("/api/tele/token", JSONObject().put("session", session).put("id", apptId)))

    suspend fun patientToken(code: String, phone: String, identity: String?): Joined {
        val body = JSONObject().put("code", code).put("phone", phone)
        if (identity != null) body.put("identity", identity)
        return joined(post("/api/tele/token", body))
    }

    /** Host controls for the doctor: admit, remove, mute, end. */
    suspend fun meet(action: String, session: String, room: String, identity: String?) {
        val body = JSONObject().put("session", session).put("room", room)
        if (identity != null) body.put("identity", identity)
        post("/api/meet/$action", body)
    }

    // ----- patient check-in (AI history taking) -----

    /** Next interview question. [turns] alternate assistant (the question JSON) and user (the answer). */
    suspend fun checkinNext(lang: String, age: String, sex: String, turns: List<Pair<String, String>>): JSONObject {
        val arr = JSONArray()
        turns.forEach { (role, content) -> arr.put(JSONObject().put("role", role).put("content", content)) }
        return post("/api/checkin/next", JSONObject().put("lang", lang).put("age", age).put("sex", sex).put("turns", arr))
    }

    /** Saves the check-in; the server builds the English case sheet. Returns { token, patientId, newPatient }. */
    suspend fun checkinFinish(
        name: String, age: String, sex: String, phone: String, lang: String,
        qa: List<Pair<String, String>>, urgent: Boolean, patientId: String = "", patientSession: String? = null,
    ): JSONObject {
        val arr = JSONArray()
        qa.forEach { (q, a) -> arr.put(JSONObject().put("q", q).put("a", a)) }
        val o = post("/api/checkin/finish", JSONObject()
            .put("patient", JSONObject().put("name", name).put("age", age).put("sex", sex).put("phone", phone).put("id", patientId))
            .put("lang", lang).put("qa", arr).put("urgent", urgent).apply { if (patientSession != null) put("patientSession", patientSession) })
        return o
    }

    // ----- doctor: OPD -----

    suspend fun visits(session: String, date: String): List<JSONObject> {
        val arr = post("/api/doctor/visits", JSONObject().put("session", session).put("date", date)).optJSONArray("visits") ?: JSONArray()
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    suspend fun visit(session: String, id: String): JSONObject =
        post("/api/doctor/visit", JSONObject().put("session", session).put("id", id)).getJSONObject("visit")

    suspend fun saveVisit(session: String, id: String, patch: JSONObject) {
        post("/api/doctor/visit/save", JSONObject().put("session", session).put("id", id).put("patch", patch))
    }

    /** Asks the AI (OpenAI, through the server) for a JSON answer. */
    suspend fun aiJson(session: String, prompt: String): JSONObject {
        val o = post("/api/ai", JSONObject().put("session", session).put("prompt", prompt).put("json", true))
        return o.optJSONObject("json") ?: throw ApiException("The AI reply was empty. Try again.")
    }

    /** Who the software is licensed to, plan and expiry date (no sign-in needed). */
    suspend fun license(): JSONObject = get("/api/license")

    /** Any POST endpoint of the Rx Clinic server. */
    suspend fun call(path: String, body: JSONObject): JSONObject = post(path, body)

    private fun joined(o: JSONObject) = Joined(
        o.getString("url"), o.getString("token"), o.getString("identity"), o.getString("role"),
        o.getString("room"), o.optString("title"),
    )

    private suspend fun get(path: String): JSONObject = request("GET", path, null)
    private suspend fun post(path: String, body: JSONObject): JSONObject = request("POST", path, body)

    private suspend fun request(method: String, path: String, body: JSONObject?): JSONObject = withContext(Dispatchers.IO) {
        if (baseUrl.isBlank()) throw ApiException("Set the Rx Clinic server address in Settings first.")
        val conn = try {
            URL(baseUrl + path).openConnection() as HttpURLConnection
        } catch (e: Exception) {
            throw ApiException("The server address looks wrong. Check it in Settings.")
        }
        try {
            conn.requestMethod = method
            conn.connectTimeout = 15_000
            conn.readTimeout = 90_000
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = runCatching { JSONObject(text) }.getOrNull()
            if (code !in 200..299 || json == null) {
                throw ApiException(json?.optString("error")?.takeIf { it.isNotBlank() } ?: "Server error ($code)")
            }
            json
        } catch (e: ApiException) {
            throw e
        } catch (e: Exception) {
            throw ApiException("Can't reach the Rx Clinic server. Check your internet.")
        } finally {
            conn.disconnect()
        }
    }
}
