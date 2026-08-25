# KGC_Lab_Calculators

نظام حاسبات مختبر جلفنة KGC — لوحة متابعة الأحواض الحية وحاسبة معايرة الحمض.

## الملفات

- `index.html` — الملف الرئيسي (يحتوي على جميع الأقسام: لوحة الأحواض، حاسبة المعايرة، سجل العمليات، إلخ)
- `acid-titration-calc.html` — قسم حاسبة معايرة الحمض (منفصل)
- `tanks-interactive-v2.html` — قسم لوحة الأحواض التفاعلية (منفصل)

## الرابط الحالي (GitHub Pages)

```
https://alshehrimohd2025-coder.github.io/KGC_Lab_Calculators/
```

## لربط هذا المجلد بالـ repository الموجود وربطه مباشرة (Push)

الـ repository موجود بالفعل على GitHub باسم `KGC_Lab_Calculators` تحت الحساب `alshehrimohd2025-coder`، وفيه commit واحد سابق برفع يدوي.

نفّذ الأوامر التالية داخل هذا المجلد:

```bash
git init
git remote add origin https://github.com/alshehrimohd2025-coder/KGC_Lab_Calculators.git
git add .
git commit -m "Update: <اكتب هنا وصف التعديل>"
git branch -M main
git push -u origin main --force
```

> ملاحظة: استخدم `--force` فقط في أول مرة لمزامنة هذا المجلد مع الـ repository الموجود (لأن هذا مجلد جديد بدون تاريخ commits سابق). بعد أول push ناجح، احذف `--force` من الأوامر القادمة واستخدم `git pull` قبل أي `push` جديد لتفادي فقدان أي تعديل.

### المصادقة

عند الطلب باسم المستخدم وكلمة المرور، استخدم:
- **Username:** اسم حساب GitHub (`alshehrimohd2025-coder`)
- **Password:** Personal Access Token (وليس كلمة مرور الحساب) — يُنشأ من:
  `github.com/settings/tokens?type=beta` → صلاحية `Contents: Read and write` على هذا الـ repository فقط.

### تفعيل GitHub Pages (لو احتجت تعيده)

Settings → Pages → Source: `Deploy from a branch` → Branch: `main` / `(root)` → Save.

## سياق المشروع

- تم بناء الموقع بمساعدة Claude (Cowork) على شكل صفحة HTML واحدة تدعم RTL والعربية بالكامل.
- البيانات محفوظة محلياً عبر `localStorage` في متصفح كل مستخدم (لا يوجد حفظ مركزي على السيرفر).
- المستخدم يخطط لجمع بيانات فعلية من خط الإنتاج لمدة شهرين، ثم تحليلها وإضافتها للموقع.
- الموقع خاص التوزيع حالياً (لم يُشارك بعد) — سيُشارك لاحقاً مع مدير الجودة ومدير المصنع فقط عبر رابط GitHub Pages أعلاه.
