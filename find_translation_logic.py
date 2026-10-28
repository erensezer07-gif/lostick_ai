with open("main.py", "r", encoding="utf-8") as f:
    lines = f.readlines()

out = []
found = False
for idx, line in enumerate(lines):
    if "def _run_translation" in line or "_run_translation" in line and "def" in line:
        start = max(0, idx - 2)
        end = min(len(lines), idx + 80)
        out.append(f"--- Context around line {idx+1} ---")
        for i in range(start, end):
            if i < len(lines):
                out.append(f"{i+1}: {lines[i]}")
        out.append("-" * 30)
        found = True

with open("translation_logic_output.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(out))

print("Search completed. Found:", found)
