#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KGC — تصدير يومي لبيانات خط الجلفنة إلى ملف Excel.

يسحب كل البيانات من Firebase ويكتب ملف .xlsx بعدة أوراق داخل
~/Documents/KGC_Reports/ باسم يحمل تاريخ اليوم.

مكتوب بمكتبات بايثون القياسية فقط — لا يحتاج pip ولا تثبيت أي شيء،
حتى لا ينكسر مع تحديثات النظام. يعمل حتى لو كان المتصفح مغلقاً.

التشغيل يدوياً:   python3 daily_export.py
التشغيل التلقائي: عبر launchd (انظر install_daily_export.sh)
"""

import datetime
import io
import json
import os
import re
import ssl
import sys
import urllib.request
import zipfile

# ----------------------------------------------------------------------------
# الإعدادات
# ----------------------------------------------------------------------------

DB = "https://kgc-galvanizing-monitor-default-rtdb.asia-southeast1.firebasedatabase.app"
# macOS يحمي ~/Documents أحياناً من المهام التلقائية، فيوجد مجلد بديل احتياطي
OUT_DIR = os.path.expanduser("~/Documents/KGC_Reports")
FALLBACK_DIR = os.path.expanduser("~/KGC_Reports")
TIMEOUT = 30

STAGE_NAMES = {
    "loading": "التحميل", "crane_attach": "التركيب على الرافعة",
    "crane_wait": "انتظار الرافعة", "crane_move": "حركة الرافعة",
    "degreasing": "إزالة الشحوم", "rinse_pre_acid": "غسيل قبل الحمض",
    "acid": "الحمض", "rinse_post_acid": "غسيل بعد الحمض",
    "flux": "الفلكس", "drying": "الدراينج", "wait_zinc": "انتظار الفرن",
    "zinc": "فرن الزنك", "cooling": "التبريد", "inspection": "فحص الجودة",
    "rework": "إعادة معالجة",
}
KIND_NAMES = {
    "stage": "مرحلة", "immersion": "غمر", "draining": "تقطير",
    "wait": "انتظار", "downtime": "توقف", "rework": "إعادة معالجة",
}
TANK_NAMES = {
    "acid_1": "حمض 1", "acid_2": "حمض 2", "acid_3": "حمض 3", "acid_4": "حمض 4",
    "rinse_1": "غسيل 1", "rinse_2": "غسيل 2", "stripping": "حمض التعرية",
}
TANK_LABELS = {
    "Flux Tank": "تانك الفلكس", "Rinsing Tank 1": "تانك غسيل 1",
    "Rinsing Tank 2": "تانك غسيل 2", "Rinsing Before Acid": "تانك غسيل قبل الحمض",
    "Temporary Acid Tank": "تانك حمض مؤقت",
    "Stripping Acid": "تانك حمض التعرية", "Acid Tank 1": "تانك حمض 1",
    "Acid Tank 2": "تانك حمض 2", "Acid Tank 3": "تانك حمض 3",
    "Acid Tank 4": "تانك حمض 4", "Degreasing Tank": "تانك إزالة الشحوم",
    "Drying": "الدراينج", "Zinc Tank": "فرن الزنك",
}
STATUS_LABELS = {
    "in_service": "داخل الخدمة", "maintenance": "تحت الصيانة",
    "needs_review": "يحتاج مراجعة", "out_of_service": "خارج الخدمة",
    "good": "داخل الخدمة", "warning": "يحتاج مراجعة", "critical": "خارج الخدمة",
}


# ----------------------------------------------------------------------------
# كاتب xlsx بسيط (مكتبات قياسية فقط)
# ----------------------------------------------------------------------------

def col_letter(idx):
    """0 -> A, 25 -> Z, 26 -> AA"""
    s = ""
    idx += 1
    while idx:
        idx, rem = divmod(idx - 1, 26)
        s = chr(65 + rem) + s
    return s


_ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def xml_escape(v):
    s = _ILLEGAL.sub("", str(v))
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;").replace("'", "&apos;"))


def sheet_xml(rows, rtl=True):
    """rows = list of lists. Numbers become numeric cells, everything else text."""
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
           '<sheetViews><sheetView workbookViewId="0"%s>'
           '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
           '</sheetView></sheetViews>' % (' rightToLeft="1"' if rtl else ""),
           "<sheetData>"]
    for r, row in enumerate(rows, start=1):
        out.append('<row r="%d">' % r)
        for c, val in enumerate(row):
            ref = "%s%d" % (col_letter(c), r)
            if val is None or val == "":
                continue
            style = ' s="1"' if r == 1 else ""
            if isinstance(val, bool):
                val = "نعم" if val else "لا"
            if isinstance(val, (int, float)):
                out.append('<c r="%s"%s><v>%s</v></c>' % (ref, style, val))
            else:
                out.append('<c r="%s"%s t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>'
                           % (ref, style, xml_escape(val)))
        out.append("</row>")
    out.append("</sheetData></worksheet>")
    return "".join(out)


STYLES_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF0B6B60"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
</styleSheet>"""


def write_xlsx(path, sheets):
    """sheets = list of (name, rows)"""
    n = len(sheets)
    content_types = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
                     '<Default Extension="xml" ContentType="application/xml"/>',
                     '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
                     '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>']
    for i in range(1, n + 1):
        content_types.append('<Override PartName="/xl/worksheets/sheet%d.xml" '
                             'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % i)
    content_types.append("</Types>")

    wb = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>']
    for i, (name, _) in enumerate(sheets, start=1):
        safe = xml_escape(name[:31].replace("/", "-").replace("\\", "-"))
        wb.append('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (safe, i, i))
    wb.append("</sheets></workbook>")

    rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
    for i in range(1, n + 1):
        rels.append('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/'
                    'officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>' % (i, i))
    rels.append('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/'
                'officeDocument/2006/relationships/styles" Target="styles.xml"/>' % (n + 1))
    rels.append("</Relationships>")

    root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                 'relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "".join(content_types))
        z.writestr("_rels/.rels", root_rels)
        z.writestr("xl/workbook.xml", "".join(wb))
        z.writestr("xl/_rels/workbook.xml.rels", "".join(rels))
        z.writestr("xl/styles.xml", STYLES_XML)
        for i, (_, rows) in enumerate(sheets, start=1):
            z.writestr("xl/worksheets/sheet%d.xml" % i, sheet_xml(rows))


# ----------------------------------------------------------------------------
# جلب البيانات
# ----------------------------------------------------------------------------

# ----------------------------------------------------------------------------
# الدخول (حين تصبح القراءة تتطلب تسجيلاً)
# ----------------------------------------------------------------------------
# كلمة المرور لا تُكتب في هذا الملف أبداً: تُقرأ من سلسلة مفاتيح macOS.
# أضِفها مرة واحدة بالأمر (يطلب كلمة المرور منك بنفسه):
#   security add-generic-password -s kgc-backup -a <بريد حساب المشاهدة> -w
# بدونها يقرأ السكربت كما كان (يعمل ما دامت القراءة مفتوحة).
API_KEY = "AIzaSyCCqt5vp8BPvKto38CUrS5cos-8Dpvgu40"   # مفتاح ويب عام، ليس سراً
_TOKEN = {"v": None}


def _keychain():
    import subprocess
    try:
        acct = subprocess.run(["security", "find-generic-password", "-s", "kgc-backup"],
                              capture_output=True, text=True, timeout=10).stdout
        m = re.search(r'"acct"<blob>="([^"]+)"', acct)
        pw = subprocess.run(["security", "find-generic-password", "-s", "kgc-backup", "-w"],
                            capture_output=True, text=True, timeout=10).stdout.strip()
        return (m.group(1), pw) if m and pw else None
    except Exception:                              # noqa: BLE001
        return None


def _token():
    if _TOKEN["v"] is not None:
        return _TOKEN["v"] or None
    cred = _keychain()
    if not cred:
        _TOKEN["v"] = ""
        return None
    body = json.dumps({"email": cred[0], "password": cred[1], "returnSecureToken": True}).encode()
    req = urllib.request.Request(
        "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + API_KEY,
        data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ssl.create_default_context()) as r:
            _TOKEN["v"] = json.loads(r.read().decode("utf-8")).get("idToken") or ""
    except Exception as exc:                       # noqa: BLE001
        print("تعذّر تسجيل الدخول للنسخ الاحتياطي: %s" % exc, file=sys.stderr)
        _TOKEN["v"] = ""
    return _TOKEN["v"] or None


def fetch(path, shallow=False):
    q = []
    tok = _token()
    if tok:
        q.append("auth=" + tok)
    if shallow:
        q.append("shallow=true")
    url = "%s/%s.json%s" % (DB, path, ("?" + "&".join(q)) if q else "")
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT, context=ctx) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as exc:                      # noqa: BLE001 - report and continue
        print("تعذّر جلب %s: %s" % (path or "/", exc), file=sys.stderr)
        return None


def wait_for_network(tries=12, gap=300):
    """الساعة ٤:٣٠ قد يكون الجهاز صحا للتو بلا اتصال (هذا ما أفشل ١–٣ أكتوبر).
    ننتظر حتى ساعة، ونجرّب كل ٥ دقائق، قبل أن نعتبر اليوم فاشلاً."""
    import time
    import socket
    host = DB.split("//", 1)[1]
    for i in range(tries):
        try:
            socket.getaddrinfo(host, 443)
            return True
        except OSError:
            if i == tries - 1:
                return False
            print("لا يوجد اتصال — إعادة المحاولة بعد %d دقيقة" % (gap // 60), file=sys.stderr)
            time.sleep(gap)
    return False


# ----------------------------------------------------------------------------
# أدوات الوقت
# ----------------------------------------------------------------------------

def ts_clock(ms):
    if not ms:
        return ""
    return datetime.datetime.fromtimestamp(ms / 1000.0).strftime("%H:%M:%S")


def ts_date(ms):
    if not ms:
        return ""
    return datetime.datetime.fromtimestamp(ms / 1000.0).strftime("%Y-%m-%d")


def minutes(ms):
    if ms is None:
        return ""
    return round(ms / 60000.0, 2)


def seg_list(batch):
    segs = batch.get("segments") or []
    if isinstance(segs, dict):                     # Firebase may return a map
        segs = [segs[k] for k in sorted(segs, key=lambda x: int(x))]
    return [s for s in segs if s]


def seg_len(s):
    start, end = s.get("startTs"), s.get("endTs")
    if not start or not end:
        return 0
    return end - start


def batch_totals(b):
    t = {"processing": 0, "draining": 0, "waiting": 0, "downtime": 0,
         "crane_wait": 0, "crane_move": 0}
    for s in seg_list(b):
        d = seg_len(s)
        kind = s.get("kind")
        if kind == "wait":
            t["waiting"] += d
        elif kind == "downtime":
            t["downtime"] += d
        elif kind == "draining":
            t["draining"] += d
        elif kind == "rework":
            continue
        else:
            t["processing"] += d
            if s.get("stageKey") == "crane_wait":
                t["crane_wait"] += d
            elif s.get("stageKey") == "crane_move":
                t["crane_move"] += d
    start, end = b.get("startTs"), b.get("endTs")
    t["cycle"] = (end - start) if (start and end) else 0
    return t


# ----------------------------------------------------------------------------
# بناء الأوراق
# ----------------------------------------------------------------------------

def sheet_batches(batches):
    rows = [["رقم الدفعة", "المنتج", "عدد القطع", "الوزن (كجم)", "أمر التشغيل",
             "التاريخ", "البداية", "النهاية", "الحالة",
             "الزمن الكلي (د)", "المعالجة (د)", "التقطير (د)", "الانتظار (د)",
             "التوقف (د)", "انتظار الرافعة (د)", "حركة الرافعة (د)",
             "مشكلة", "نوع المشكلة", "وصف المشكلة", "إعادة معالجة", "ملاحظات"]]
    for b in batches:
        t = batch_totals(b)
        issue = b.get("issue") or {}
        lvl = issue.get("level") or "none"
        reworks = b.get("reworks") or []
        if isinstance(reworks, dict):
            reworks = list(reworks.values())
        rows.append([
            b.get("batchNumber", ""), b.get("product", ""),
            b.get("pieces", 0) or 0, b.get("weight", 0) or 0, b.get("workOrder", ""),
            ts_date(b.get("startTs")), ts_clock(b.get("startTs")), ts_clock(b.get("endTs")),
            "مكتملة" if b.get("status") == "done" else "جارية",
            minutes(t["cycle"]), minutes(t["processing"]), minutes(t["draining"]),
            minutes(t["waiting"]), minutes(t["downtime"]),
            minutes(t["crane_wait"]), minutes(t["crane_move"]),
            "لا" if lvl == "none" else ("كبيرة" if lvl == "major" else "بسيطة"),
            issue.get("type", ""), issue.get("description", ""),
            len(reworks), b.get("notes", ""),
        ])
    return rows


def sheet_segments(batches):
    """الورقة التحليلية: صف لكل حدث زمني — أساس كل الحسابات لاحقاً."""
    rows = [["رقم الدفعة", "المنتج", "الوزن (كجم)", "التاريخ", "التسلسل",
             "المرحلة", "النوع", "الحوض", "البداية", "النهاية", "المدة (د)",
             "السبب", "معدّل يدوياً"]]
    for b in batches:
        for i, s in enumerate(seg_list(b)):
            key = s.get("stageKey", "")
            rows.append([
                b.get("batchNumber", ""), b.get("product", ""), b.get("weight", 0) or 0,
                ts_date(b.get("startTs")), i + 1,
                s.get("stageName") or STAGE_NAMES.get(key, key),
                KIND_NAMES.get(s.get("kind"), s.get("kind", "")),
                TANK_NAMES.get(s.get("tank"), s.get("tank") or ""),
                ts_clock(s.get("startTs")), ts_clock(s.get("endTs")),
                minutes(seg_len(s)) if s.get("endTs") else "",
                s.get("reason") or "",
                "نعم" if s.get("edited") else "",
            ])
    return rows


def _avg(vals):
    vals = [v for v in vals if v]
    return round(sum(vals) / len(vals) / 60000.0, 2) if vals else ""


def sheet_analysis(batches):
    done = [b for b in batches if b.get("status") == "done" and b.get("endTs")]
    rows = [["المؤشر", "القيمة", "الوحدة", "عدد العينات"]]
    if not done:
        rows.append(["لا توجد دفعات مكتملة بعد", "", "", 0])
        return rows

    tot = [batch_totals(b) for b in done]
    total_hours = sum(t["cycle"] for t in tot) / 3600000.0
    weight = sum((b.get("weight") or 0) for b in done)
    pieces = sum((b.get("pieces") or 0) for b in done)
    issues = sum(1 for b in done if (b.get("issue") or {}).get("level", "none") != "none")

    rows += [
        ["عدد الدفعات المكتملة", len(done), "دفعة", len(done)],
        ["إجمالي الوزن", round(weight, 1), "كجم", len(done)],
        ["إجمالي القطع", pieces, "قطعة", len(done)],
        ["متوسط زمن الدورة", _avg([t["cycle"] for t in tot]), "دقيقة", len(done)],
        ["متوسط المعالجة", _avg([t["processing"] for t in tot]), "دقيقة", len(done)],
        ["متوسط التقطير", _avg([t["draining"] for t in tot]), "دقيقة", len(done)],
        ["متوسط الانتظار", _avg([t["waiting"] for t in tot]), "دقيقة", len(done)],
        ["متوسط التوقف", _avg([t["downtime"] for t in tot]), "دقيقة", len(done)],
        ["متوسط انتظار الرافعة", _avg([t["crane_wait"] for t in tot]), "دقيقة", len(done)],
        ["متوسط حركة الرافعة", _avg([t["crane_move"] for t in tot]), "دقيقة", len(done)],
        ["الإنتاجية", round(weight / total_hours, 1) if total_hours else "", "كجم/ساعة", len(done)],
        ["الإنتاجية", round(pieces / total_hours, 2) if total_hours else "", "قطعة/ساعة", len(done)],
        ["دفعات بها مشاكل", issues, "دفعة", len(done)],
        ["نسبة الدفعات السليمة", round((len(done) - issues) / len(done) * 100, 1), "%", len(done)],
        ["", "", "", ""],
        ["متوسط كل مرحلة", "", "", ""],
    ]

    by_stage, by_tank, by_drain, by_product = {}, {}, {}, {}
    for b in done:
        by_product.setdefault(b.get("product") or "—", []).append(batch_totals(b)["cycle"])
        for s in seg_list(b):
            d = seg_len(s)
            if not d:
                continue
            kind, key, tank = s.get("kind"), s.get("stageKey", ""), s.get("tank")
            if kind in ("stage", "immersion"):
                by_stage.setdefault(s.get("stageName") or STAGE_NAMES.get(key, key), []).append(d)
                if kind == "immersion" and tank:
                    by_tank.setdefault(TANK_NAMES.get(tank, tank), []).append(d)
            elif kind == "draining" and tank:
                by_drain.setdefault(TANK_NAMES.get(tank, tank), []).append(d)

    for name, vals in sorted(by_stage.items(), key=lambda kv: -sum(kv[1])):
        rows.append([name, _avg(vals), "دقيقة", len(vals)])
    rows.append(["", "", "", ""])
    rows.append(["متوسط الغمر لكل حوض", "", "", ""])
    for name, vals in sorted(by_tank.items()):
        rows.append([name, _avg(vals), "دقيقة", len(vals)])
    rows.append(["", "", "", ""])
    rows.append(["متوسط التقطير لكل حوض", "", "", ""])
    for name, vals in sorted(by_drain.items()):
        rows.append([name, _avg(vals), "دقيقة", len(vals)])
    rows.append(["", "", "", ""])
    rows.append(["متوسط زمن الدورة لكل منتج", "", "", ""])
    for name, vals in sorted(by_product.items()):
        rows.append([name, _avg(vals), "دقيقة", len(vals)])
    return rows


def sheet_tanks(tanks):
    rows = [["الحوض", "pH", "Fe (g/L)", "Baumé", "نسبة الحمض %", "الزمن (د)", "SP", "T", "الحالة"]]
    if not tanks:
        return rows
    if isinstance(tanks, dict):
        tanks = [tanks[k] for k in sorted(tanks, key=lambda x: int(x) if str(x).isdigit() else 0)]
    for t in tanks:
        if not t:
            continue
        rows.append([
            TANK_LABELS.get(t.get("name"), t.get("name", "")),
            t.get("ph", ""), t.get("fe", ""), t.get("baume", ""),
            t.get("acidPercent", ""), t.get("time", ""), t.get("sp", ""), t.get("t", ""),
            STATUS_LABELS.get(t.get("status"), t.get("status", "")),
        ])
    return rows


def sheet_titration(log):
    rows = [["التاريخ", "الوقت", "التانك", "نسبة الحمض %"]]
    if not log:
        return rows
    items = list(log.values()) if isinstance(log, dict) else list(log)
    items = [i for i in items if i]
    items.sort(key=lambda r: (r.get("date", ""), r.get("time", "")), reverse=True)
    for r in items:
        rows.append([r.get("date", ""), r.get("time", ""), r.get("tankName", ""),
                     round(float(r.get("percent", 0) or 0), 2)])
    return rows


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------

# ----------------------------------------------------------------------------
# النسخة الاحتياطية الخام
# ----------------------------------------------------------------------------

# كل الفروع الموجودة فعلاً تُقرأ من قاعدة البيانات نفسها، فأي قسم جديد
# في الموقع (شيتات الشدّات، الرماد، إضافات الملح...) يدخل النسخة تلقائياً
# بدل أن تفوته قائمة مكتوبة يدوياً كما حدث سابقاً.
def backup_roots():
    top = fetch("", shallow=True)
    return sorted(top.keys()) if isinstance(top, dict) else []

BACKUP_DIRNAME = "backups"
KEEP_DAILY = 30          # آخر ٣٠ يوماً تُحفظ كاملة


def write_backup(folder, stamp):
    """ينسخ قاعدة البيانات كما هي إلى ملف JSON واحد.

    الملف Excel للقراءة البشرية؛ هذه النسخة للاستعادة: تحفظ كل فرع بصيغته
    الأصلية بحيث يمكن رفعها إلى Firebase مرة أخرى كما هي إن ضاع المشروع.
    """
    data, missing = {}, []
    for root in backup_roots():
        value = fetch(root)
        if value is None:
            missing.append(root)
        else:
            data[root] = value

    if not data:
        return None, missing

    payload = {
        "exportedAt": stamp.isoformat(timespec="seconds"),
        "database": DB,
        "roots": sorted(data.keys()),
        "data": data,
    }

    bdir = os.path.join(folder, BACKUP_DIRNAME)
    os.makedirs(bdir, exist_ok=True)
    path = os.path.join(bdir, "kgc_backup_%s.json" % stamp.strftime("%Y-%m-%d"))
    with io.open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1, sort_keys=True)

    prune_backups(bdir)
    return path, missing


def prune_backups(bdir):
    """يبقي آخر KEEP_DAILY نسخة، وأول نسخة من كل شهر قبلها.

    بهذا لا يتضخم المجلد، ويبقى أثر تاريخي شهري يمكن الرجوع إليه.
    """
    try:
        files = sorted(f for f in os.listdir(bdir)
                       if re.match(r"^kgc_backup_\d{4}-\d{2}-\d{2}\.json$", f))
    except OSError:
        return
    if len(files) <= KEEP_DAILY:
        return

    keep = set(files[-KEEP_DAILY:])
    first_of_month = {}
    for f in files:
        month = f[12:19]                      # YYYY-MM
        first_of_month.setdefault(month, f)
    keep.update(first_of_month.values())

    for f in files:
        if f in keep:
            continue
        try:
            os.remove(os.path.join(bdir, f))
        except OSError:
            pass


def main():
    stamp = datetime.datetime.now()
    print("KGC daily export — %s" % stamp.strftime("%Y-%m-%d %H:%M:%S"))
    if not wait_for_network():
        print("لا يوجد اتصال بعد ساعة من المحاولة — لم يُنشأ ملف.", file=sys.stderr)
        return 1

    production = fetch("production") or {}
    tanks = fetch("tanks_data")
    titration = fetch("titration_log")

    raw = production.get("batches") or {}
    batches = [b for b in (raw.values() if isinstance(raw, dict) else raw) if b]
    batches.sort(key=lambda b: b.get("startTs") or 0, reverse=True)

    if not batches and not tanks and not titration:
        print("لا توجد بيانات — لم يُنشأ ملف.", file=sys.stderr)
        return 1

    sheets = [
        ("ملخص الدفعات", sheet_batches(batches)),
        ("المراحل التفصيلية", sheet_segments(batches)),
        ("التحليل", sheet_analysis(batches)),
        ("الأحواض", sheet_tanks(tanks)),
        ("سجل المعايرة", sheet_titration(titration)),
    ]

    name = "KGC_%s.xlsx" % stamp.strftime("%Y-%m-%d")
    path = None
    for folder in (OUT_DIR, FALLBACK_DIR):
        try:
            os.makedirs(folder, exist_ok=True)
            candidate = os.path.join(folder, name)
            write_xlsx(candidate, sheets)
            path = candidate
            break
        except (PermissionError, OSError) as exc:
            print("تعذّرت الكتابة في %s (%s)" % (folder, exc), file=sys.stderr)
    if path is None:
        print("فشل حفظ الملف في كل المجلدات.", file=sys.stderr)
        return 1

    print("تم الحفظ: %s" % path)
    print("الدفعات: %d · صفوف المراحل: %d" % (len(batches), len(sheets[1][1]) - 1))

    # النسخة الاحتياطية تُكتب بجوار التقرير، وفشلها لا يُفشل التصدير
    try:
        bpath, missing = write_backup(os.path.dirname(path), stamp)
        if bpath:
            size = os.path.getsize(bpath)
            print("نسخة احتياطية: %s (%.1f KB)" % (bpath, size / 1024.0))
            if missing:
                print("فروع فارغة أو غير موجودة: %s" % ", ".join(missing))
        else:
            print("تعذّر إنشاء النسخة الاحتياطية — لا توجد بيانات.", file=sys.stderr)
    except Exception as exc:                      # noqa: BLE001 - never break the export
        print("فشلت النسخة الاحتياطية: %s" % exc, file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
