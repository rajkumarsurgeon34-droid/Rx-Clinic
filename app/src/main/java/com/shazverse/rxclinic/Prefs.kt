package com.shazverse.rxclinic

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** A booking the patient made on this phone, so they can find it again. */
data class MyBooking(val code: String, val phone: String, val name: String, val date: String, val time: String, val mode: String)

/** Small local store: server address, staff sign-in, and the patient's own bookings. */
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

    /** Signed-in staff session, per role. */
    fun session(role: String): String? = sp.getString("session_$role", null)

    /** The role's own sign-in, or the admin's (admin can open every section). */
    fun sessionFor(role: String): String? = session(role) ?: session("admin")
    fun saveSession(role: String, token: String?) =
        sp.edit().apply { if (token == null) remove("session_$role") else putString("session_$role", token) }.apply()

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
