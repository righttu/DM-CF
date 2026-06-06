import os
# 自动安装 modelscope (如果还没装)
try:
    from modelscope.hub.snapshot_download import snapshot_download
except ImportError:
    os.system("pip install modelscope")
    from modelscope.hub.snapshot_download import snapshot_download

def download_official_model():
    # 🎯 官方正版 ID (来自你的截图)
    model_id = "BAAI/bge-small-zh-v1.5"
    
    # 指定下载目录 (我们还是放在 models 文件夹下)
    local_dir = os.path.join(os.getcwd(), "models", "bge-small-zh-v1.5")
    
    print(f"🚀 开始从 ModelScope 下载官方正版: {model_id}")
    print(f"📂 目标路径: {local_dir}")
    
    try:
        # ModelScope 下载速度极快，无需魔法
        path = snapshot_download(model_id, cache_dir=local_dir)
        print(f"\n✅ 下载成功！")
        print(f"实际存储路径: {path}")
        
        print("-" * 50)
        print("👇 关键一步：请修改 knowledge_miner.py 的配置：")
        # 注意：这里路径里变成了 v1.5
        print(f"EMBEDDING_MODEL_PATH = r'{path}'") 
        
    except Exception as e:
        print(f"\n❌ 下载失败: {e}")

if __name__ == "__main__":
    download_official_model()
