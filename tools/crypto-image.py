#!/usr/bin/env python3
"""
文本文件加密工具：将文件加密后编码为 PNG 图片，凭密钥还原。

用法:
  加密: python3 crypto-image.py encrypt <输入文件> <密钥> <输出图片.png>
  解密: python3 crypto-image.py decrypt <输入图片.png> <密钥> <输出文件>

原理:
  1. 用密钥(字符串) 经 SHA-256 派生出 AES-256 密钥
  2. AES-256-CBC 加密文件内容
  3. 密文字节按 RGB 像素排列，存为 PNG 图片(无损)
  4. 解密时读取像素还原字节，再用密钥解密

注意: 必须用 PNG，JPG 是有损压缩会破坏数据!
"""

import sys
import os
import hashlib
import struct
import math
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad
from PIL import Image


def derive_key(password):
    """字符串密钥 -> 32字节 AES 密钥"""
    return hashlib.sha256(password.encode('utf-8')).digest()


def encrypt_file(input_path, password, output_image):
    """加密文件并保存为 PNG 图片"""
    # 读取文件
    with open(input_path, 'rb') as f:
        plaintext = f.read()

    # AES-256-CBC 加密
    key = derive_key(password)
    iv = os.urandom(16)
    cipher = AES.new(key, AES.MODE_CBC, iv)
    ciphertext = cipher.encrypt(pad(plaintext, AES.block_size))

    # 组装 payload: [4字节长度][16字节IV][密文]
    payload = struct.pack('>I', len(ciphertext)) + iv + ciphertext
    total_bytes = len(payload)

    # 计算图片尺寸 (正方形, 每像素3字节)
    pixel_count = math.ceil(total_bytes / 3)
    side = math.ceil(math.sqrt(pixel_count))

    # 填充到完整像素
    padded = payload + os.urandom(side * side * 3 - total_bytes)

    # 生成图片
    img = Image.new('RGB', (side, side))
    pixels = []
    for i in range(0, len(padded), 3):
        pixels.append((padded[i], padded[i + 1], padded[i + 2]))
    img.putdata(pixels)
    img.save(output_image, 'PNG')

    print(f"加密完成!")
    print(f"  原始文件: {input_path} ({len(plaintext)} bytes)")
    print(f"  图片输出: {output_image} ({side}x{side} pixels)")
    print(f"  图片大小: {os.path.getsize(output_image)} bytes")


def decrypt_file(input_image, password, output_path):
    """从 PNG 图片中解密还原文件"""
    # 读取图片像素
    img = Image.open(input_image)
    pixels = list(img.getdata())

    # 像素 -> 字节
    raw = bytearray()
    for pixel in pixels:
        raw.extend(pixel[:3])

    # 解析 payload
    ciphertext_len = struct.unpack('>I', bytes(raw[:4]))[0]
    iv = bytes(raw[4:20])
    ciphertext = bytes(raw[20:20 + ciphertext_len])

    # AES-256-CBC 解密
    key = derive_key(password)
    cipher = AES.new(key, AES.MODE_CBC, iv)
    try:
        plaintext = unpad(cipher.decrypt(ciphertext), AES.block_size)
    except ValueError:
        print("错误: 密钥不正确或图片数据已损坏!")
        sys.exit(1)

    # 写入文件
    with open(output_path, 'wb') as f:
        f.write(plaintext)

    print(f"解密完成!")
    print(f"  图片输入: {input_image}")
    print(f"  还原文件: {output_path} ({len(plaintext)} bytes)")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == 'encrypt':
        if len(sys.argv) != 5:
            print("用法: python3 crypto-image.py encrypt <输入文件> <密钥> <输出图片.png>")
            sys.exit(1)
        encrypt_file(sys.argv[2], sys.argv[3], sys.argv[4])

    elif cmd == 'decrypt':
        if len(sys.argv) != 5:
            print("用法: python3 crypto-image.py decrypt <输入图片.png> <密钥> <输出文件>")
            sys.exit(1)
        decrypt_file(sys.argv[2], sys.argv[3], sys.argv[4])

    else:
        print(f"未知命令: {cmd}")
        print("可用命令: encrypt, decrypt")
        sys.exit(1)


if __name__ == '__main__':
    main()
