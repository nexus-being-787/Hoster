import os
from PIL import Image, ImageDraw

def create_round_mask(size):
    mask = Image.new('L', size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0) + size, fill=255)
    return mask

def process_image(img_path, res_path):
    sizes = {
        'mdpi': 48,
        'hdpi': 72,
        'xhdpi': 96,
        'xxhdpi': 144,
        'xxxhdpi': 192,
    }
    
    with Image.open(img_path) as img:
        img = img.convert("RGBA")
        
        # Center crop the inner rounded square (since the AI usually adds its own padding)
        # Let's crop slightly to remove the outer dark grey background if any
        width, height = img.size
        crop_amount = int(width * 0.1) # Crop 10% from each side
        img_cropped = img.crop((crop_amount, crop_amount, width - crop_amount, height - crop_amount))
        
        for density, size in sizes.items():
            folder = os.path.join(res_path, f"mipmap-{density}")
            os.makedirs(folder, exist_ok=True)
            
            # Resize
            resized = img_cropped.resize((size, size), Image.Resampling.LANCZOS)
            
            # Save square (or whatever shape the crop is)
            resized.save(os.path.join(folder, "ic_launcher.png"))
            
            # Create round version
            round_img = resized.copy()
            mask = create_round_mask((size, size))
            round_img.putalpha(mask)
            round_img.save(os.path.join(folder, "ic_launcher_round.png"))
            
            print(f"Generated {density} ({size}x{size})")

if __name__ == "__main__":
    img_file = "/home/titan/.gemini/antigravity/brain/a125fd08-1f44-4675-bb03-24c8eba8c237/hoster_app_icon_1790647826052.jpg"
    res_dir = "/home/titan/React/Hoster/HosterApp/android/app/src/main/res"
    process_image(img_file, res_dir)
