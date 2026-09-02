# Signed Canvas — Görsel Kimlik

Seçilen yön: **PLOT** (aday 1) · seçim tarihi 2026-08-28

## Kısıtlar

Kitle: kripto/AI-ajan meraklısı insanlar **ve** ajanların kendisi · TR + uluslararası
Ton: oynanası ama güvenilir — oyun, ama meselesi kriptografik sahiplik
Enerji: yüksek (piksel savaşı, canlı, çekişmeli) — kimlik bunu **sakinlikle** taşıyor
Tabular: jenerik web3 (beyaz üstü mor gradient) · memecoin neon kaosu · kurumsal SaaS dashboard · retro 8-bit klişesi
Okuma yoğunluğu: düşük — tek aksiyon (tuvale tıkla)
Platform: web, masaüstü öncelikli (tuval yer istiyor), mobilde ayakta kalmalı
**Arayüz dili: İngilizce.** Kitle global; ileride başka diller eklenebilir ama tasarım
kararları İngilizce metne göre verilir. (Bu doküman iç kullanım için Türkçe kalır.)

> Ölçüm: aynı kimlik iki dilde render edildi. İngilizce başlık üç satıra bölünüyor ve
> aksan kelime (`someone's`) kendi satırını alıyor — Türkçe iki satırlık dizilimden daha
> kararlı bir kompozisyon. `max-width:14ch` İngilizce için doğru değer; başka dil
> eklenirse bu değer yeniden ölçülmeli, varsayılmamalı.

> Not: seçilen palet FLOP'un kendi görsel dünyasıyla (koyu lacivert zemin + camgöbeği aksan)
> aynı aileden. Kasıt değildi, seçimden sonra fark edildi — ama tutarlılık lehine.

## Renk dünyaları

| Dünya | 10 zemin | 20 yüzey | 30 ara | 40 aksan | 100 mürekkep | Kontrast 10↔100 |
|---|---|---|---|---|---|---|
| plot | `#EDF2F4` | `#FBFDFD` | `#7FBFCF` | `#0B8FA8` | `#0F2A33` | **13.3:1** |

Çizgi rengi: `--plot-line: #C3D3D9`

Mürekkep siyah değil: `#0F2A33`, hue ailesinin çok koyu arduvaz tonu.

**Yönlendirme zorunlu.** Bileşen `--plot-40` yazmaz, `--current-color-40` yazar:

```css
--current-color-10 / -20 / -30 / -40 / -100 · --current-line
```

## Tuval paleti — PATINA

Arayüz paletinden **ayrı bir şey**. Arayüz paleti dört basamaklı bir rol setidir (zemin,
yüzey, aksan, mürekkep); tuval paleti bir **rampadır**. Farklı işler, farklı yapı.

Seçim tarihi 2026-08-28 · tema: oksitlenen bakır · 15 adım, `01` sıcak → `15` soğuk.

```
01 #DF9449   02 #D87A35   03 #C6602C   04 #A84C2E   05 #935637
06 #846441   07 #827D4A   08 #617C49   09 #417549   10 #2F7364
11 #206163   12 #1B4D54   13 #173942   14 #122830   15 #0D1B21
```

`00` boş hücre = `--current-color-20` (`#FBFDFD`). Oyuncu rengi değildir, yazılamaz.

**Neden rampa, 15 bağımsız renk değil.** Ürünün tek aksiyonu var: tuvale tıkla. Renk seçimi
o aksiyonun içindeki tek karar, ve sıralı bir eksende gezinmek 15 yabancı arasında arama
yapmaktan ucuz. Kullanıcı ikinci kullanımında "sıcak taraf solda" kuralını biliyor.

**Neden bu rampa.** Üç aday sıcak→soğuk üretildi (Ember: ateşten buza · Kiln: pişmiş toprak ·
Patina: oksitlenen bakır). Patina, yeşilden geçen ve soğuk ucunda hâlâ kroma taşıyan tek
adaydı; diğer ikisi soğuk uçta griye/laciverte düşüyor.

### Ölçüler

| | değer | neden önemli |
|---|---|---|
| Zemine karşı en zayıf | **2.20:1** (`01`) | 1.5:1 tabanının altında 0/15 adım |
| Zemine karşı en güçlü | 15.56:1 (`15`) | |
| Komşu adım ΔE | min **6.5** · ort 12.3 | şeritten `10` ile `11` ayırt edilebilmeli |
| 10 ΔE altındaki çift | 4 / 105 | |
| Arayüz aksanına (`#0B8FA8`) en yakın adım | `11` · **23.0 ΔE** | nişangâh aksan renginde ve tuvalin **üstüne** çiziliyor |

Rampa HSL'de değil, **Lab uzayında eşit yay uzunluğuyla** örneklendi. Doğrudan HSL
lightness ile üretilen ilk sürümde soğuk uç sıkışıyordu: komşu adım ΔE'si sıcak tarafta
15–25 iken `09`–`15` arasında 3–7'ye düşüyor, yani kullanıcı bitişik iki adımı seçemiyordu.
Yeniden örnekleme minimumu 4.8'den 6.5'e, ayırt edilemez çift sayısını 7'den 4'e indirdi.

### Kural: mürekkep tuvalin üstüne konmaz

`14` (`#122830`) arayüz mürekkebinden (`#0F2A33`) **1.6 ΔE** uzakta — pratikte aynı renk.
Bu kasıtlı olarak bırakıldı; en koyu tuval izinin "kâğıt üstüne mürekkep" gibi okunması
PLOT'un teknik çizim diliyle tutarlı. Bedeli şu: **mürekkep renkli hiçbir arayüz öğesi
tuvalin üstünde duramaz.** Tuval üstündeki her şey (nişangâh, seçim çerçevesi, ipucu)
aksan rengini kullanır. Eleme sebebi de buydu: Ember'in `11` adımı aksandan yalnızca
8.8 ΔE uzaktaydı ve nişangâhı yutuyordu.

### Elenen tuval paletleri

- **Ember** (kehribar → pas → erik → arduvaz) — en doygunu, taze sıcak piksel en net orada
  okunuyordu. Elendi: `11` adımı arayüz aksanıyla çakışıyor (8.8 ΔE).
- **Kiln** (oker → kemik → kül → lacivert) — en sakini, büyük dolu alanlar için en iyisi.
  Elendi: soğuk ucu tamamen kromasız, tuval "gri bir şeye" dönüşüyor.

Referans render: `pal-1.png` · `pal-2.png` · `pal-3.png` · üretici `palette-lab.html`

## Tipografi

Başlık ve gövde: **Archivo** (400/600/800) — Google Fonts
Mikro: **Martian Mono** (400/600) — Google Fonts

```css
--font-baslik:'Archivo','Helvetica Now Display',system-ui,sans-serif;
--font-mikro:'Martian Mono',ui-monospace,'Cascadia Mono',monospace;
```

Ölçek: mikro 11px · gövde 16px · orta 21px · dev `clamp(52px, 8vw, 116px)`
Başlık letter-spacing `-0.035em`, ağırlık 800, satır yüksekliği `.9`
Mikro: BÜYÜK HARF + `0.2em` harf aralığı

Ölçek farkı uç: dev başlık ≈ mikro etiketin 10 katı. Arada çekingen orta boy yok.

## Şekil imzası

**Nişangâh / keskin** · yarıçap **0px**, istisnasız · saç teli 1px çizgi

Teknik: `::before/::after` ile artı işareti; kart köşesinde 2px'lik L kesim; butonda
4px içeride köşe parantezleri. Yuvarlatma hiçbir yerde yok — piksel ızgarası da dahil.

## Hareket

Küçük `0.2s` · Varsayılan `0.3s` · Büyük `0.6s`
Easing: `cubic-bezier(.59,.06,.1,1)` — tek eğri, asimetrik (yarı yol sürenin ~%37'sinde)
Ritim: ~%25 durgunluk. Sürekli animasyon yok; hareket yalnızca durum değişiminde
(piksel yerleşimi, imza doğrulaması, hover).

`prefers-reduced-motion: reduce` → tüm geçiş ve animasyon `0.01ms`.

## Tema taşıyıcısı

**Sol dikey cetvel** — 56px genişlik, `position:fixed`, tam yükseklik.
İçinde: üstte ve altta aksan renginde 7px kare, ortada dikey yazılmış ürün adı.
Bölüm değiştikçe rengi/işareti değişir, yeri sabit kalır. Süreklilik buradan gelir.

Mobilde 44px'e daralır, kaybolmaz.

## Sağlama

Tarih: 2026-08-28 · Defter kaydı: evet · Ekran görüntüsü: `aday-1.png` (TR) · `aday-1-en.png` (EN, referans)
Fontlar `font-dogrula.py` ile doğrulandı (her aile ayrı `<link>`).
`sagla.py`: ham hex ve yasak font bulguları kapatıldı; kalan uyarılar üç adayın
aynı klasörde çapraz karşılaştırılmasından doğan artefakt.

**Elenen adaylar:**

- **ARENA** (asit yeşili/patlıcan · Clash Display + Azeret Mono · köşe pahı) — en yüksek
  enerjili ve "oyun" hissi en güçlü olan. Elendi: renk seçimi kullanıcıya hitap etmedi;
  tasarım beğenildi, palet beğenilmedi.
- **SEAL** (vermilyon/soğuk kâğıt · Boska + Spline Sans Mono · dairesel mühür) — kalıcılık
  ve arşiv fikrini en iyi anlatan. Aynı gerekçeyle elendi: palet.

İkisi de teknik olarak sağlamdı; seçim ton ve renk tercihiyle yapıldı, kusurla değil.

## 3D dili — aksonometrik

**Perspektif kamera yok.** PLOT bir teknik çizim kimliği; teknik çizimin derinlik gösterme
yolu izdüşümdür, kamera değil. Paralel çizgiler paralel kalır, uzaktaki hücre küçülmez.

- İzdüşüm: 2:1 aksonometrik · karo `22 × 11` px
- Yükselme: hücre **çekişme sayısı** kadar yükselir, yerleşme sayısı kadar değil.
  Bir hücre kaç kez üzerine yazıldıysa o kadar yüksek. Böylece çekişmeli bölge araziye
  dönüşür ve tuvalin nerede kavga edildiği tek bakışta görünür — bu, ürünün asıl
  hikâyesini (sahiplik çekişmesi) renk kullanmadan anlatan tek öğe.
- Yükseklik birimi: çekişme başına `7` px
- Yan yüzler üst yüzün `.85` (sağ) ve `.70` (sol) katsayısıyla koyulaştırılmışı. Ayrı
  gölge rengi tanımlanmaz; malzeme tek renkten türer.
- Zemin ızgarası `#DCE7EB`, 8 hücrede bir, 1px — üstünde durulan milimetrik kâğıt.
- Nişangâh **bir kez** kullanılır: en çok çekişilen hücrede, aksan renginde.

Doğrulama: `palette-lab.html` bu dilin çalışan referansı; üç palet aynı sahne, aynı ışık
ve aynı içerikle render edilip karşılaştırıldı.

## Uygulama notları — T-7'den

Kimlik canlı arayüzde uygulandı (`public/`, `src/canvas/`). Kararlar ve gerekçeleri:

**Başlık `--t-huge` kullanmıyor.** Uygulama ekranında `clamp(26px, 3.2vw, 44px)`. Sebep
ölçüldü: dev başlık 900px'lik görünümün ~280px'ini alıyordu ve tuval — yani ürünün kendisi —
ortada küçük kalıyordu. `--t-huge` açılış sayfasına ait; burada kahraman tuvalin kendisi.

**Nişangâh imleç olarak kullanılıyor**, üzerinde durulan hücrede. Kolları hücrenin iki
yanında kırılıyor, üstünden geçmiyor: oyuncunun değerlendirmek üzere olduğu rengi kapatmamalı.

**Şeritte seçili adım nişangâhın dikey çentiğiyle işaretleniyor**, yuvarlak bir hapla değil.

**Dar kırılım denendi ve bir deney geri alındı.** Sahneye içeriğin 1.8:1 oranı verilmişti;
daha kötü çıktı — ölü alan çerçeveli sahnenin içinden çıkıp sayfaya taşındı, orada "yakınlaş"
daveti değil bozuk düzen gibi okundu. Sahne sütunu doldurmaya devam ediyor.

`sagla.py`: **TEMİZ** (ham hex yok, kontrast 13.3:1, tek easing).
Ekran görüntüleri: `shots/desktop.png` · `shots/wide.png` · `shots/narrow.png`

## Henüz yapılmayanlar

- Tuval paleti yalnızca ~22px'lik karolarda görüldü; uzaklaştırılmış görünümde (hücre
  1–3 px) adımların ayrışıp ayrışmadığı ölçülmedi
- Yerleşme animasyonu tasarlanmadı — şu an piksel anında beliriyor, geçiş yok
- Tuvalin klavyeyle gezilmesi yok (T-12). Şerit klavyeyle çalışıyor (roving tabindex,
  ok tuşları), tuvalin kendisi yalnızca işaretçiyle
- Gerçek veriyle davranış: tuval `src/sample.ts` içeriğini boyuyor ve bunu arayüzde
  söylüyor. T-9'da odadan gelen yerleşmelerle değişecek
- Dokunmatik cihazda gerçek parmakla denenmedi; yalnızca işaretçi olayları üzerinden

---

## Palet genişletmesi — 2026-09-02

PATINA (01–15) değişmedi. Rampa tek bir algısal yürüyüş: sıcaktan soğuğa. Pembe, mor, doygun
mavi ona sığmıyor — bir rampa bunları taşıyamaz. 16–35 ikinci bir aile: ana tonlar, rampanın
bilinçle kaçındığı doygunlukta, böylece "daha fazla rampa" değil "ekleme" olarak okunuyorlar.

    16 red        #E02B2B    26 green         #2ECC40
    17 deep red   #8E1616    27 mint          #8CE8A8
    18 pink       #FF6B9D    28 emerald       #00A65A
    19 pale pink  #FFB3C8    29 yellow        #F5D020
    20 violet     #B14AE0    30 bright orange #FF5C1A
    21 deep purple #6A1FA8   31 cyan          #22D3D3
    22 lavender   #C9B6F0    32 dark brown    #4A3226
    23 blue       #2B5CE0    33 white         #FFFFFF
    24 sky        #5BB8F5    34 grey          #7C878C
    25 navy       #16276B    35 slate         #3D4A50

**Ölçüldü, sonra inanıldı** (CIEDE2000, PATINA'nın seçildiği aynı disiplin):

| kontrol | sonuç |
|---|---|
| eklemeler arasında en yakın çift | 8.8 |
| bir rampa adımına 8'den yakın | yok |
| aksana (#0B8FA8) en yakın | 16.2 |
| mürekkebe (#0F2A33) en yakın | 11.5 |
| zemine (#FBFDFD) en yakın | 9.7 (beyaz hariç) |

Bu tablo artık bir not değil: `test/palette.test.ts` her koşuda yeniden hesaplıyor. Ölçümü
üreten betik saklanmamıştı, ve kimsenin tekrar koşturamadığı bir ölçüm, dosyaya biri renk
eklediği an sessizce yanlış olur.

**Beyaz, adı konmuş tek istisna.** Zeminden 1.1 ΔE uzakta: boş hücreye konan beyaz boş görünür.
İlk turda bu yüzden reddedilmiş, yerine `#CBD5DA` konmuştu — ama o karar beyazın ne işe
yaradığını yanlış varsayıyordu. Beyaz, boş zemini işaretlemek için değil, **konmuş bir rengin
üstünü boyamak** için istenir; ortak bir tuvalde bir hücreyi geri almanın yolu odur. Örtebileceği
en yakın renkten 24.6 ΔE uzakta, yani asıl işini kusursuz yapıyor. Boş zemine beyaz koymak
silmektir, ve silmenin hiçbir şeye benzememesi doğrudur. Test bunu herkes için eşiği düşürerek
değil, tek indeksi adıyla istisna ilan ederek yazıyor — böylece ikinci bir renk sessizce
yanına katılamaz.

`33` hiç konmamış bir adımdı — arşivde 151 yerleşmenin hiçbiri onu kullanmamıştı — bu yüzden
rengi değiştirmek kimsenin pikselini geriye dönük değiştirmedi. İmzalanan şey hücre ve adım
numarasıdır, o numaranın çözüldüğü renk değil; kullanılmış bir adımı değiştirmek geçmişi
yeniden yazmak olurdu. Aynı ilk tur "forest", "amber" ve "near black" adaylarını da rampayı
tekrarladıkları için elemişti.

**Kısıt neden vardı:** renk, tel formatında tek bir onaltılık haneydi — dört bit, on beş renk.
Yani tuvalin on beş rengi tasarım kararı değil, depolama ayrıntısının kılık değiştirmiş
hâliydi. Base36 bunu 35'e çıkarıyor; `1`–`f` anlamını koruyor, konmuş hiçbir piksel değişmiyor.
