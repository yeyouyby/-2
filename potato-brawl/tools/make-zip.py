# 打包发布 zip
#   1) 内置 node_modules（离线双击即用）
#   2) 所有文件名保持纯 ASCII（Windows 资源管理器解压不乱码）
#   3) 打包前后校验：拒绝 0 字节文件、校验解压后字节一致
#
# 用法: python3 tools/make-zip.py
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VER = 'v1.0.3'
OUT = os.path.join(os.path.dirname(ROOT), f'PotatoBrawl-{VER}-LAN.zip')
SKIP_DIRS = {'.git', '__pycache__', 'shots', '.cache', '.idea', '.vscode'}
SKIP_EXT = ('.zip', '.log', '.pyc', '.tmp')
CRLF_FILES = ('start.bat', 'troubleshoot.bat')   # 只规范化 ASCII 脚本；start-cn.bat 是 GBK，原样保留


def normalize_crlf(name):
    """先读入内存再写回 —— 顺序反了会把文件清空（曾经的 bug）。"""
    path = os.path.join(ROOT, name)
    if not os.path.exists(path):
        return
    with open(path, 'rb') as f:
        data = f.read()
    data = data.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
    with open(path, 'wb') as f:
        f.write(data)


def lint_bat():
    """cmd 里 echo 文本中的裸括号会被当成语法符号，导致 'xxx 不应有 then' 之类的报错。"""
    problems = []
    for name in ('start.bat', 'start-cn.bat', 'troubleshoot.bat'):
        path = os.path.join(ROOT, name)
        if not os.path.exists(path):
            problems.append(f'{name}: 缺失')
            continue
        text = open(path, 'rb').read().decode('gbk' if name == 'start-cn.bat' else 'ascii', 'replace')
        for i, line in enumerate(text.splitlines(), 1):
            s = line.strip()
            if '(' not in s and ')' not in s:
                continue
            if s.startswith('for ') or s.startswith('if ') or s.startswith('call '):
                continue          # for / if / call 语法自带的括号是合法的
            if s.startswith('echo') or s.startswith('title') or s.startswith('set '):
                problems.append(f'{name}:{i}: {s}')
    return problems


def main():
    for n in CRLF_FILES:
        normalize_crlf(n)

    print('  bat 语法体检 ...')
    bad = lint_bat()
    if bad:
        print('  [X] echo 文本里发现裸括号，拒绝打包：')
        for p in bad:
            print('      ', p)
        sys.exit(1)
    print('       OK - 没有会把 cmd 搞崩的裸括号')

    files = []
    for dirpath, dirnames, names in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in sorted(names):
            if fn == '.DS_Store' or fn.endswith(SKIP_EXT):
                continue
            full = os.path.join(dirpath, fn)
            files.append(full)

    # ---- 打包前检查：0 字节 / 空文件一律拒绝 ----
    empty = [f for f in files if os.path.getsize(f) == 0]
    if empty:
        print('  [X] 发现 0 字节文件，拒绝打包：')
        for f in empty:
            print('      ', os.path.relpath(f, ROOT))
        sys.exit(1)

    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for full in files:
            arc = os.path.normpath(
                os.path.join('potato-brawl', os.path.relpath(full, ROOT))
            ).replace(os.sep, '/')
            z.write(full, arc)
        z.write(os.path.join(ROOT, 'GUIDE-CN.txt'), 'READ-ME-FIRST.txt')

    # ---- 打包后校验 ----
    ok = True
    with zipfile.ZipFile(OUT) as z:
        names = z.namelist()
        nonascii = [n for n in names if any(ord(c) > 127 for c in n)]
        zero = [i.filename for i in z.infolist() if i.file_size == 0]
        if z.testzip() is not None:
            print('  [X] zip 完整性校验失败:', z.testzip())
            ok = False
        if nonascii:
            print('  [X] 存在非 ASCII 文件名:', nonascii)
            ok = False
        if zero:
            print('  [X] 存在 0 字节条目:', zero)
            ok = False

        print(f'  条目数 {len(names)} | 完整性 {"OK" if z.testzip() is None else "BAD"} '
              f'| 非 ASCII 文件名 {len(nonascii)} | 0 字节条目 {len(zero)}')

        print('  关键文件核对：')
        for key in ('potato-brawl/start.bat', 'potato-brawl/start-cn.bat',
                    'potato-brawl/troubleshoot.bat', 'potato-brawl/GUIDE-CN.txt',
                    'potato-brawl/server/index.js', 'potato-brawl/node_modules/ws/package.json',
                    'READ-ME-FIRST.txt'):
            info = z.getinfo(key) if key in names else None
            size = info.file_size if info else -1
            flag = 'OK ' if info and size > 100 else 'BAD'
            if flag == 'BAD':
                ok = False
            print(f'     [{flag}] {size:>7} 字节  {key}')

        # 字节级校验：从压缩包里读出来和磁盘文件比
        for key in ('potato-brawl/start.bat', 'potato-brawl/start-cn.bat',
                    'potato-brawl/troubleshoot.bat'):
            disk = open(os.path.join(ROOT, key.split('/', 1)[1]), 'rb').read()
            inzip = z.read(key)
            same = disk == inzip
            if not same:
                ok = False
            print(f'     [{"OK " if same else "BAD"}] 字节一致  {key}')

    print(f'  {"✅ 打包成功" if ok else "[X] 打包存在问题"} -> {OUT}  ({os.path.getsize(OUT)/1024:.1f} KB)')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    print(f'  打包 {VER} ...')
    main()
