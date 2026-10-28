import sqlite3
import json

conn = sqlite3.connect("kullanim_cache.db")
cursor = conn.cursor()

try:
    cursor.execute("SELECT cache_key, response FROM llm_cache;")
    rows = cursor.fetchall()
    updated_count = 0
    
    for row in rows:
        cache_key = row[0]
        raw_val = row[1]
        
        try:
            parsed = json.loads(raw_val)
            if isinstance(parsed, dict) and "cevap" in parsed:
                cevap = parsed["cevap"]
                
                # If cevap is a list of dicts (e.g. [{'type': 'text', 'text': '...'}]), extract text
                if isinstance(cevap, list):
                    parts = []
                    for part in cevap:
                        if isinstance(part, dict) and "text" in part:
                            parts.append(part["text"])
                        elif isinstance(part, str):
                            parts.append(part)
                    
                    extracted_text = "".join(parts)
                    parsed["cevap"] = extracted_text
                    
                    # Update back in DB
                    new_val = json.dumps(parsed, ensure_ascii=False)
                    cursor.execute("UPDATE llm_cache SET response = ? WHERE cache_key = ?;", (new_val, cache_key))
                    updated_count += 1
                    print(f"Fixed cache key {cache_key[:8]}...")
        except Exception as e:
            pass
            
    conn.commit()
    print(f"Cache repair completed. Updated {updated_count} rows.")
except Exception as e:
    print("Error:", e)
finally:
    conn.close()
