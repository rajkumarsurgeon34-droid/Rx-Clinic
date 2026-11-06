package com.shazverse.rxclinic

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** A booking the patient made on this phone, so they can find it again. */
data class MyBooking(val code: String, val phone: String, val name: String, val date: String, val time: String, val mode: String)

/** Small local store: server address, staff and patient sign-in, and the patient's own bookings. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("rx_clinic", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = (sp.getString("server", null)?.takeIf { it.isNotBlank() } ?: BuildConfig.DEFAULT_SERVER_URL).trim().trimEnd('/')
        set(v) = sp.edit().putString("server", v.trim().trimEnd('/')).apply()

    var startWithCamera: Boolean
        get() = sp.getBoolean("cam_on", true)
        set(v) = sp.edit().putBoolean("cam_on", v).apply()

    var startWithMic: Boolean
        get() = sp.getBoolean("mic_on", true)
        set(v) = sp.edit().putBoolean("mic_on", v).apply()

    // ----- staff sign-in (one login per device at a time) -----

    /** The signed-in staff role: doctor, staff, pharmacy, lab, diagnostics or admin. */
    val staffRole: String? get() = sp.getString("staff_role", null)?.takeIf { sp.getString("staff_session", null) != null }
    var staffUsername: String
        get() = sp.getString("staff_username", "") ?: ""
        set(v) = sp.edit().putString("staff_username", v).apply()

    /** The session if the signed-in login has exactly this role. */
    fun session(role: String): String? = if (staffRole == role) sp.getString("staff_session", null) else null

    /** The role's session, or the admin's (the admin can open every section). */
    fun sessionFor(role: String): String? = if (staffRole == role || staffRole == "admin") sp.getString("staff_session", null) else null

    /** Saves the session after sign-in; null signs out. */
    fun saveSession(role: String, token: String?) =
        sp.edit().apply {
            if (token == null) { remove("staff_session"); remove("staff_role") }
            else { putString("staff_session", token); putString("staff_role", role) }
        }.apply()

    // ----- patient sign-in -----

    val patientSession: String? get() = sp.getString("patient_session", null)
    val patientId: String get() = sp.getString("patient_id", "") ?: ""
    val patientName: String get() = sp.getString("patient_name", "") ?: ""

    fun savePatient(token: String?, id: String = "", name: String = "") =
        sp.edit().apply {
            if (token == null) { remove("patient_session"); remove("patient_id"); remove("patient_name") }
            else { putString("patient_session", token); putString("patient_id", id); putString("patient_name", name) }
        }.apply()

    var doctorName: String
        get() = sp.getString("doctor_name", "") ?: ""
        set(v) = sp.edit().putString("doctor_name", v).apply()

    fun bookings(): List<MyBooking> {
        val arr = runCatching { JSONArray(sp.getString("bookings", "[]")) }.getOrDefault(JSONArray())
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            MyBooking(o.optString("code"), o.optString("phone"), o.optString("name"), o.optString("date"), o.optString("time"), o.optString("mode"))
        }.sortedWith(compareBy({ it.date }, { it.time }))
    }

    fun saveBooking(b: MyBooking) {
        val list = bookings().filter { it.code != b.code } + b
        val arr = JSONArray()
        list.forEach {
            arr.put(JSONObject().put("code", it.code).put("phone", it.phone).put("name", it.name)
                .put("date", it.date).put("time", it.time).put("mode", it.mode))
        }
        sp.edit().putString("bookings", arr.toString()).apply()
    }

    fun removeBooking(code: String) {
        val arr = JSONArray()
        bookings().filter { it.code != code }.forEach {
            arr.put(JSONObject().put("code", it.code).put("phone", it.phone).put("name", it.name)
                .put("date", it.date).put("time", it.time).put("mode", it.mode))
        }
        sp.edit().putString("bookings", arr.toString()).apply()
    }
}
