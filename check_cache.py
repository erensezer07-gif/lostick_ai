import sqlite3

conn = sqlite3.connect("kullanim_cache.db")
cursor = conn.cursor()

try:
    cursor.execute("SELECT cache_key, response, cached_at FROM llm_cache ORDER BY cached_at DESC LIMIT 5;")
    rows = cursor.fetchall()
    print("Latest cache rows:")
    for row in rows:
        print("Key:", row[0])
        print("Response (first 300 chars):", repr(row[1])[:300])
        print("Cached at:", row[2])
        print("-" * 50)
except Exception as e:
    print("Error:", e)

conn.close()
