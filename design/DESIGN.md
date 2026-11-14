# دیزاین‌سیستم JARVIS

منبع حقیقت: `design/tokens.json` — با `npm run design` به `public/tokens.css` (متغیرهای CSS) و `public/icons.svg` (اسپرایت آیکون) تبدیل می‌شود. همین فرمان کنتراست متن/پس‌زمینه را در هر دو تم چک می‌کند و اگر جفتی زیر ۴٫۵:۱ باشد خطا می‌دهد.

## جهت طراحی
- **سبک:** Dark Mode + داشبورد متراکم (پیشنهاد ui-ux-pro-max برای ابزار توسعه‌دهنده؛ `rtl_level: full`). تم روشن هم هست.
- **فونت:** Vazirmatn برای متن فارسی/انگلیسی، JetBrains Mono برای کد و اعداد فنی — هر دو داخل برنامه (بدون اینترنت).
- **آیکون:** Lucide (SVG، لایسنس ISC) — هیچ ایموجی‌ای در رابط به‌عنوان آیکون استفاده نمی‌شود.
- **رنگ هویت:** فیروزه‌ای (برند)، نارنجی = Claude، بنفش = Codex، صورتی = ساب‌ایجنت. رنگ‌های وضعیت (سبز/زرد/قرمز/آبی) فقط برای وضعیت‌اند و همیشه همراه آیکون و متن.
- **نمودارها:** پالت دسته‌ای ۸ رنگ اعتبارسنجی‌شده برای کوررنگی، جدا برای هر تم (`--chart-1..8`).

## سه لایه‌ی توکن
| لایه | نمونه | کاربرد |
|---|---|---|
| Primitive | `--p-color-slate-950`, `--p-space-4`, `--p-radius-lg` | مقادیر خام؛ تقریباً هیچ‌وقت عوض نمی‌شوند |
| Semantic | `--color-bg`, `--color-fg-muted`, `--color-primary`, `--text-sm` | معنا؛ تم روشن فقط همین لایه را بازنویسی می‌کند |
| Component | `--button-primary-bg`, `--card-radius`, `--sidebar-width` | تنظیم هر کامپوننت |

قاعده: در `style.css` هیچ رنگ hex و هیچ اندازه‌ی px ثابت (جز breakpointها) نیست — `validate-tokens` این را بررسی می‌کند.

## کامپوننت‌ها
| کامپوننت | پیش‌فرض | Hover | Active | Disabled |
|---|---|---|---|---|
| دکمه‌ی اصلی `.btn-primary` | `--button-primary-bg` / متن `--button-primary-fg` | `--button-primary-bg-hover` + درخشش | یک پیکسل پایین | شفافیت ۴۵٪ |
| دکمه‌ی ثانویه `.btn` | `--button-secondary-bg` | `--button-secondary-bg-hover` | یک پیکسل پایین | شفافیت ۴۵٪ |
| دکمه‌ی شبح `.btn-ghost` | شفاف | `--button-ghost-bg-hover` | — | شفافیت ۴۵٪ |
| دکمه‌ی خطر `.btn-danger` | `--button-danger-bg` | پس‌زمینه‌ی قرمز کامل | — | شفافیت ۴۵٪ |
| ورودی `.field input` | `--input-bg`, `--input-border` | — | فوکوس: `--input-border-focus` + هاله | شفافیت ۴۵٪ |

اندازه‌ها: کنترل‌ها `--control-h-sm` (۲۸)، `--control-h-md` (۳۶)، `--control-h-lg` (۴۴). همه‌ی کنترل‌ها حلقه‌ی فوکوس قابل‌دیدن دارند (`--color-focus`) و `prefers-reduced-motion` رعایت می‌شود.

## دارایی‌ها
`npm run assets` (با Electron) از روی `public/logo.svg` و `design/assets/*.html` می‌سازد:
- `build/icon.ico` (۱۶ تا ۲۵۶) و `build/icon.png`
- `build/installerSidebar.bmp` (۱۶۴×۳۱۴) و `build/installerHeader.bmp` (۱۵۰×۵۷) برای نصب‌کننده
- `docs/banners/*-1280x640.png` — سه جهت هنری: نئون، گلس‌مورفیسم، هندسی
