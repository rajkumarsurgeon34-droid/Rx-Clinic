package com.shazverse.rxclinic.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.print.PrintAttributes
import android.print.PrintManager
import android.util.Base64
import android.webkit.WebView
import android.webkit.WebViewClient
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.shazverse.rxclinic.Prefs
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Printing and PDF: every document is built as HTML with the clinic letterhead and sent to Android's
 * print screen, where the user picks a printer or "Save as PDF".
 */
object Printer {
    private var keep: WebView? = null // the WebView must live until printing starts

    @SuppressLint("SetJavaScriptEnabled")
    fun print(context: Context, job: String, html: String) {
        val wv = WebView(context)
        keep = wv
        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                val pm = context.getSystemService(Context.PRINT_SERVICE) as PrintManager
                pm.print(job, view.createPrintDocumentAdapter(job), PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build())
            }
        }
        wv.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
    }
}

internal fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
private val LONG_DATE = DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.ENGLISH)
internal fun longDate(iso: String): String = runCatching { LocalDate.parse(iso).format(LONG_DATE) }.getOrDefault(iso)

/** A4 page with the clinic letterhead; [body] is HTML. */
internal fun page(prefs: Prefs, title: String, body: String, signer: String = prefs.doctorName, qual: String = prefs.staffQual, reg: String = prefs.staffReg, sign: Boolean = true): String {
    val c = runCatching { JSONObject(prefs.clinicJson) }.getOrDefault(JSONObject())
    val clinic = c.optString("name").ifBlank { "Rx Clinic" }
    return """<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 14mm 14mm 16mm; }
body { font-family: "Noto Sans", Roboto, Arial, sans-serif; color: #15201f; font-size: 11.5pt; line-height: 1.45; margin: 0; }
.head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.5px solid #0e6a64; padding-bottom: 8px; }
.name { font-family: Georgia, "Noto Serif", serif; font-size: 21pt; font-weight: 700; color: #0e6a64; }
.rx { color: #b3261e; }
.sub { font-size: 9.5pt; color: #4b5b58; }
.right { text-align: right; font-size: 9.5pt; color: #4b5b58; }
h1 { font-family: Georgia, serif; font-size: 15pt; margin: 14px 0 8px; text-align: center; letter-spacing: .5px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 18px; background: #eef4f3; border-radius: 6px; padding: 7px 10px; font-size: 10.5pt; margin-bottom: 10px; }
.meta b { font-weight: 600; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 10.5pt; }
th { text-align: left; background: #0e6a64; color: #fff; font-weight: 600; padding: 5px 7px; }
td { border-bottom: 1px solid #d6e0dd; padding: 5px 7px; vertical-align: top; }
td.r, th.r { text-align: right; }
.tot td { font-weight: 700; border-bottom: 0; }
h3 { font-size: 11.5pt; margin: 12px 0 4px; color: #0e6a64; }
ul { margin: 2px 0 6px; padding-left: 18px; }
.sign { margin-top: 36px; display: flex; justify-content: flex-end; }
.sign div { text-align: center; min-width: 200px; border-top: 1px solid #15201f; padding-top: 4px; font-size: 10pt; }
.foot { margin-top: 18px; font-size: 8.5pt; color: #6a7a77; text-align: center; border-top: 1px solid #d6e0dd; padding-top: 5px; }
.letter p { margin: 0 0 10px; text-align: justify; }
.big { font-size: 13pt; }
</style></head><body>
<div class="head"><div><div class="name"><span class="rx">℞</span> ${esc(clinic)}</div>
<div class="sub">${esc(c.optString("address"))}</div></div>
<div class="right">${esc(signer)}${if (qual.isNotBlank()) "<br>" + esc(qual) else ""}${if (reg.isNotBlank()) "<br>Reg. no. " + esc(reg) else ""}
${if (c.optString("phone").isNotBlank()) "<br>Ph: " + esc(c.optString("phone")) else ""}${if (c.optString("hours").isNotBlank()) "<br>" + esc(c.optString("hours")) else ""}</div></div>
<h1>${esc(title)}</h1>
$body
${if (sign) """<div class="sign"><div>${esc(signer)}${if (qual.isNotBlank()) "<br>" + esc(qual) else ""}${if (reg.isNotBlank()) "<br>Reg. no. " + esc(reg) else ""}</div></div>""" else ""}
<div class="foot">${esc(clinic)} · printed ${LocalDate.now().format(LONG_DATE)} · Rx Clinic</div>
</body></html>"""
}

internal fun patientMeta(name: String, age: String, sex: String, pid: String, phone: String = "", extra: String = "") =
    """<div class="meta"><span><b>Patient:</b> ${esc(name)}</span>${if (age.isNotBlank() || sex.isNotBlank()) "<span><b>Age/Sex:</b> ${esc(age)} ${esc(sex)}</span>" else ""}
${if (pid.isNotBlank()) "<span><b>Patient ID:</b> ${esc(pid)}</span>" else ""}${if (phone.isNotBlank()) "<span><b>Mobile:</b> ${esc(phone)}</span>" else ""}$extra</div>"""

/** Printable prescription. */
internal fun prescriptionHtml(
    prefs: Prefs, p: JSONObject, dx: String, surgery: String, rx: List<RxItem>, advice: List<String>,
    physio: String, psych: String, review: String, reviewNote: String, vitals: String = "",
): String {
    val rows = rx.mapIndexed { i, r ->
        "<tr><td>${i + 1}</td><td><b>${esc(r.line())}</b>${if (r.instructions.isNotBlank()) "<br><span class=sub>${esc(r.instructions)}</span>" else ""}</td><td>${esc(r.dose)}</td><td>${esc(r.frequency)}</td><td>${esc(r.timing)}</td><td>${esc(r.duration)}</td></tr>"
    }.joinToString("")
    val body = buildString {
        append(patientMeta(p.str("name"), p.str("age"), p.str("sex"), p.str("id"), "", "<span><b>Date:</b> ${LocalDate.now().format(LONG_DATE)}</span>"))
        if (vitals.isNotBlank()) append("<div class=sub>$vitals</div>")
        if (dx.isNotBlank()) append("<h3>Diagnosis</h3><div>${esc(dx)}</div>")
        if (surgery.isNotBlank()) append("<h3>Plan</h3><div>${esc(surgery)}</div>")
        if (rx.isNotEmpty()) append("<h3 class=big>℞</h3><table><tr><th>#</th><th>Medicine</th><th>Dose</th><th>When</th><th>Food</th><th>Days</th></tr>$rows</table>")
        if (advice.isNotEmpty()) append("<h3>Advice</h3><ul>${advice.joinToString("") { "<li>${esc(it)}</li>" }}</ul>")
        if (physio.isNotBlank()) append("<h3>Physiotherapy</h3><div>${esc(physio)}</div>")
        if (psych.isNotBlank()) append("<h3>Psychologist</h3><div>${esc(psych)}</div>")
        if (review.isNotBlank()) append("<h3>Review</h3><div><b>${esc(longDate(review))}</b>${if (reviewNote.isNotBlank()) " · " + esc(reviewNote) else ""}</div>")
        append("<div class=sub style='margin-top:8px'>1-0-1 = morning, afternoon, night. Come back earlier if you feel worse.</div>")
    }
    return page(prefs, "Prescription", body)
}

/** Printable bill or receipt. */
internal fun billHtml(prefs: Prefs, b: JSONObject): String {
    val p = b.obj("patient")
    val rows = b.objs("items").mapIndexed { i, it ->
        "<tr><td>${i + 1}</td><td>${esc(it.str("desc"))}</td><td class=r>${it.num("qty").let { q -> if (q % 1.0 == 0.0) q.toLong().toString() else q.toString() }}</td><td class=r>${esc(rupees(it.num("rate")))}</td><td class=r>${esc(rupees(it.num("amount")))}</td></tr>"
    }.joinToString("")
    val pays = b.objs("payments").joinToString("") { "<tr><td></td><td colspan=3>Paid · ${esc(it.str("mode"))} ${esc(it.str("ref"))} · ${esc(whenText(it.optLong("at")))}</td><td class=r>${esc(rupees(it.num("amount")))}</td></tr>" }
    val bal = b.num("balance")
    val body = buildString {
        append(patientMeta(p.str("name"), p.str("age"), p.str("sex"), p.str("id"), p.str("phone"),
            "<span><b>Bill no:</b> ${esc(b.str("no"))}</span><span><b>Date:</b> ${esc(whenText(b.optLong("created")))}</span>"))
        if (b.str("admissionNo").isNotBlank()) append("<div class=sub>Admission ${esc(b.str("admissionNo"))} · ${esc(b.str("ward"))} ${esc(b.str("bed"))} · ${esc(whenText(b.optLong("admittedAt")))} to ${esc(whenText(b.optLong("dischargedAt")))}</div>")
        append("<table><tr><th>#</th><th>Item</th><th class=r>Qty</th><th class=r>Rate</th><th class=r>Amount</th></tr>$rows")
        append("<tr class=tot><td></td><td colspan=3>Subtotal</td><td class=r>${esc(rupees(b.num("subtotal")))}</td></tr>")
        if (b.num("discount") > 0) append("<tr class=tot><td></td><td colspan=3>Discount</td><td class=r>−${esc(rupees(b.num("discount")))}</td></tr>")
        append("<tr class=tot><td></td><td colspan=3>Total</td><td class=r>${esc(rupees(b.num("total")))}</td></tr>$pays")
        if (bal > 0.004) append("<tr class=tot><td></td><td colspan=3>Balance due</td><td class=r>${esc(rupees(bal))}</td></tr>")
        if (bal < -0.004) append("<tr class=tot><td></td><td colspan=3>Refund due</td><td class=r>${esc(rupees(-bal))}</td></tr>")
        append("</table><div class=sub>Status: ${esc(billStatusLabel(b.str("status")))} · Prepared by ${esc(b.str("createdBy"))}</div>")
    }
    return page(prefs, "${b.str("deptName")} ${if (b.str("status") == "paid") "receipt" else "bill"}", body, signer = "Authorised signatory", qual = "", reg = "")
}

/** Printable certificate, letter or timeslip. */
internal fun letterHtml(prefs: Prefs, l: JSONObject): String {
    val p = l.obj("patient"); val d = l.obj("doctor")
    val text = l.obj("fields").str("text").split("\n").filter { it.isNotBlank() }.joinToString("") { "<p>${esc(it)}</p>" }
    val body = patientMeta(p.str("name"), p.str("age"), p.str("sex"), p.str("id"), "", "<span><b>Ref:</b> ${esc(l.str("no"))}</span><span><b>Date:</b> ${esc(longDate(l.str("date")))}</span>") +
        "<div class=letter>$text</div>"
    return page(prefs, l.str("title"), body, signer = d.str("name").ifBlank { prefs.doctorName }, qual = d.str("qual"), reg = d.str("reg"))
}

/** QR code as a bitmap. */
internal fun qrBitmap(text: String, size: Int = 640): Bitmap {
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 1))
    val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
    for (x in 0 until size) for (y in 0 until size) bmp.setPixel(x, y, if (m[x, y]) Color.BLACK else Color.WHITE)
    return bmp
}

internal fun qrDataUri(text: String): String {
    val out = ByteArrayOutputStream()
    qrBitmap(text, 512).compress(Bitmap.CompressFormat.PNG, 100, out)
    return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
}
