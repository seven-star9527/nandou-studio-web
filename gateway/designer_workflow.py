"""PhotoCraft recipe for an editable white-background product photograph."""
import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from PIL import Image, ImageDraw, ImageFilter, ImageChops

from .product_recognition import recognize, mixing_wells
from .quick_edits import cutout, retouch_or_enlarge, studio_white_balance, upright


STAGES = (
    ('识别品类，提取主体和真实开孔', '本地主体识别与软蒙版'),
    ('按材质校正颜色、光影与纹理', '实拍像素局部精修'),
    ('建立白底、可修主体蒙版和剪贴曲线', 'PhotoCraft'),
    ('保存分层工程与白底 PNG', 'PhotoCraft'),
)

def well_mask(matte, destination):
    """Soft local dodge/burn region around observed rows of neutral moulded wells."""
    with Image.open(matte) as im:
        small = im.copy()
        small.thumbnail((640,640),Image.Resampling.LANCZOS)
        wells,size = mixing_wells(small.convert('RGB'))
        if not wells:
            return False
        area = Image.new('L',size)
        draw = ImageDraw.Draw(area)
        for x,y,w,h in wells:
            draw.rounded_rectangle((x-w*.64,y-h*.64,x+w*.64,y+h*.64),radius=min(w,h)*.15,fill=255)
        area = ImageChops.multiply(area.filter(ImageFilter.GaussianBlur(2)),small.getchannel('A'))
        sample = Image.new('LA',im.size,(255,0))
        sample.putalpha(area.resize(im.size,Image.Resampling.BILINEAR))
        sample.save(destination)
        return True


async def render(editor, model, source, folder, category, begin, end):
    """The project embeds its sources. Discard bulky intermediate rasters after export."""
    with TemporaryDirectory(dir=folder) as temp:
        return await _render(editor,model,source,Path(temp),folder,category,begin,end)


async def _render(editor, model, source, folder, destination, category, begin, end):
    matte, original, material = (folder / n for n in ('subject.png','original.png','material.png'))
    def inspect_source():
        im = upright(source)
        alpha = im.getchannel('A')
        # An isolated transparent pixel in an otherwise opaque upload is not a cutout.
        histogram = alpha.histogram()
        supplied = sum(histogram[:16]) >= max(1,im.width*im.height*.002)
        if supplied:
            im.save(matte)
        im.convert('RGB').save(original,icc_profile=im.info.get('icc_profile'))
        return im.size, supplied
    event = begin(0)
    if category == 'auto':
        category = await asyncio.to_thread(recognize,source,model.parent/'product-recognition')
    size, supplied = await asyncio.to_thread(inspect_source)
    if not supplied:
        await cutout(model,source,matte,category=category)
    def valid_alpha():
        with Image.open(matte) as im:
            hist = im.getchannel('A').histogram()
            return bool(hist[0] and sum(hist[128:]))
    if not await asyncio.to_thread(valid_alpha):
        raise ValueError('未能分离有效主体，请先在快捷抠图中修正蒙版。')
    end(event,0)
    event = begin(1)
    def prepare():
        balance = studio_white_balance(source,category)
        retouch_or_enlarge(matte,material,'retouch',category+'|original|0',balance)
        with Image.open(material) as polished, Image.open(original) as raw:
            # Keep real photographed RGB outside the estimate so painting the
            # mask back in PhotoCraft actually recovers the missed edge.
            corrected = Image.composite(polished.convert('RGB'),raw,polished.getchannel('A'))
            corrected.save(material.with_name('corrected.png'),icc_profile=raw.info.get('icc_profile'))
        return category=='palette' and well_mask(matte,folder/'wells.png')
    wells = await asyncio.to_thread(prepare)
    end(event,1)
    event = begin(2)
    async def cmd(command, **params):
        return await editor.call('command_run',id=command,params=params)
    async def place(path,name):
        await editor.call('doc_place',path=str(path),scale=100,center=[v/2 for v in size])
        await cmd('layer.setProps',name=name)
    await editor.call('doc_new',width=size[0],height=size[1],background='white',name='设计师白底精修')
    await place(original,'实拍主体')
    await place(matte,'轮廓取样')
    await cmd('select.loadSelection',channel='transparency')
    await cmd('layer.select',name='实拍主体')
    await cmd('layer.layerMask.revealSelection')
    await cmd('layer.select',name='轮廓取样')
    await cmd('layer.delete')
    await cmd('layer.select',name='实拍主体')
    await place(folder/'corrected.png','材质与色温')
    await cmd('layer.createClippingMask')
    if wells:
        await place(folder/'wells.png','槽壁取样')
        await cmd('select.loadSelection',channel='transparency')
        await cmd('layer.select',name='材质与色温')
        await cmd('layer.newAdjustmentLayer.curves',name='调色槽局部明暗',clipToPrevious=True,
                  points=[[0,0],[140,140],[160,155],[190,189],[210,210],[230,230],[244,247],[255,255]])
        await cmd('layer.select',name='槽壁取样')
        await cmd('layer.delete')
        await cmd('layer.select',name='调色槽局部明暗')
    # Anchor whites and blacks; preserve paper highlights. Tune the curve on
    # its own layer rather than baking another sharpening pass into the photo.
    points = [[0,0],[48,46],[128,130],[210,213],[245,245],[255,255]]
    if category == 'palette':
        # Lid reflections already have a fitted lighting field. Leave the
        # global curve neutral so refining the wells cannot darken the lid.
        points = [[0,0],[255,255]]
    if category == 'paper':
        points = [[0,0],[65,65],[175,177],[224,225],[245,245],[255,255]]
    await cmd('layer.newAdjustmentLayer.curves',name='明暗层次',points=points,clipToPrevious=True)
    end(event,2)
    event = begin(3)
    await editor.call('doc_save',path=str(destination/'result.pcraft'))
    await editor.call('doc_save',path=str(destination/'result.png'))
    end(event,3)
    return category


if __name__ == '__main__':
    import argparse
    from .photocraft import PhotoCraft, load_config
    from .quick_edits import RECIPES

    cli = argparse.ArgumentParser(description='设计师白底精修：保存 PNG 与可编辑 PhotoCraft 工程')
    cli.add_argument('source',type=Path)
    cli.add_argument('output',type=Path,help='新的结果文件夹，不覆盖已有目录')
    cli.add_argument('--category',choices=RECIPES['retouch'],default='auto')
    args = cli.parse_args()

    async def main():
        root = Path(__file__).resolve().parents[1]
        source = args.source.resolve(strict=True)
        folder = args.output.resolve()
        folder.mkdir(parents=True,exist_ok=False)
        async with PhotoCraft(load_config(root)['executable'],folder,timeout=240) as editor:
            return await render(editor,root/'models/birefnet-general-lite.onnx',source,folder,args.category,
                                lambda i:print(STAGES[i][0],flush=True),lambda *_:None)
    print(asyncio.run(main()))
