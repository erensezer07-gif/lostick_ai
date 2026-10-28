# 🧠 Lostick AI — Yapay Zeka Destekli Belge Analizi, Kavram Kartı ve Eğitim Platformu

![FastAPI](https://img.shields.io/badge/Backend-FastAPI-009688?logo=fastapi&logoColor=white)
![Gemini](https://img.shields.io/badge/LLM-Google_Gemini-4285F4?logo=google&logoColor=white)
![FAISS](https://img.shields.io/badge/Vector_DB-FAISS_%2F_Chroma-8B5CF6)
![Next.js](https://img.shields.io/badge/Frontend-Next.js_&_Tailwind-000000?logo=next.js&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/Database-PostgreSQL-4169E1?logo=postgresql&logoColor=white)

**Lostick AI**, öğrencilerin ve araştırmacıların yüklediği PDF, DOCX ve PPTX ders notlarından/belgelerinden otomatik olarak **konu anlatımı**, **kavram kartları (flashcards)**, **görsel özetler** ve **gerçek hayat kullanım örnekleri** üreten RAG (Retrieval-Augmented Generation) tabanlı bir eğitim platformudur.

![Lostick AI Platform Önizlemesi](assets/lostick_preview.png)

---

## 🏗️ RAG ve Belge İşleme Mimarisi

```mermaid
flowchart LR
    A["📄 PDF / DOCX / PPTX Yükleme"] --> B["PyMuPDF & python-docx Ayrıştırıcı"]
    B --> C["FastEmbed + FAISS Vektör İndeksi"]
    C --> D["Google Gemini (LangChain RAG)"]
    D --> E["🗂️ Kavram Kartları (kavram_servisi.py)"]
    D --> F["💡 Pratik Örnekler (kullanim_servisi.py)"]
    D --> G["🖼️ Görsel Özetler (gorsel_servisi.py)"]
```

| Katman | Teknoloji |
|---|---|
| **Backend API** | FastAPI + Uvicorn |
| **Yapay Zeka / LLM** | Google Gemini (`google-genai`, `langchain-google-genai`) — BYOK (Bring Your Own Key) destekli |
| **Vektör Arama (RAG)** | FAISS / Chroma + FastEmbed |
| **Belge İşleme** | PyMuPDF, pypdf, python-docx, python-pptx, ReportLab |
| **Veritabanı & Kuyruk** | PostgreSQL (Üretim) / SQLite (Geliştirme) + Redis RQ Worker |
| **Kimlik Doğrulama** | Google & GitHub OAuth2 + PBKDF2 Oturum Yönetimi + E-posta Doğrulama |
| **Frontend** | Next.js + Tailwind CSS (`landing/`) |

---

## 🔒 Güvenlik Mimarisi (BYOK — Bring Your Own Key)

* Uygulama **BYOK** modunda çalışacak şekilde tasarlanmıştır: her kullanıcı kendi Gemini API anahtarını arayüz üzerinden güvenli şekilde kullanabilir.
* Varsayılan yönetici hesabı kaynak kodda sabit şifre barındırmaz; ilk başlatmada `secrets.token_urlsafe` ile kriptografik rastgele şifre üretilir.
* Tüm hassas yapılandırmalar `.env` üzerinden yönetilir ve sürüm kontrolüne dahil edilmez.

---

## 🚀 Kurulum ve Çalıştırma

### 1. FastAPI Backend
```bash
python -m venv venv
venv\Scripts\activate        # Linux/macOS: source venv/bin/activate
pip install -r requirements.txt

cp .env.example .env         # Windows: copy .env.example .env
uvicorn main:app --reload
```

### 2. Next.js Frontend (`landing/`)
```bash
cd landing
npm install
npm run dev
```

---

## 👨‍💻 Geliştirici
**Eren Sezer** — [GitHub Profilim](https://github.com/erensezer07-gif)
