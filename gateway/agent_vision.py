"""Keep the current visual context small without deleting stored reference assets."""
import hashlib


def compact_vision(messages, keep=24):
    # Keep the most recent appearance, where the task's edit/check instruction lives.
    latest = {}
    for i, message in enumerate(messages):
        if not isinstance(message.get('content'), list):
            continue
        for j, block in enumerate(message['content']):
            if block.get('type') == 'image_url':
                fingerprint = hashlib.sha256(block['image_url']['url'].encode()).hexdigest()
                latest[fingerprint] = (i, j)
    retained = set(sorted(latest.values())[-keep:])
    output = []
    for i, message in enumerate(messages):
        if not isinstance(message.get('content'), list):
            output.append(message)
            continue
        blocks = []
        for j, block in enumerate(message['content']):
            if block.get('type') == 'image_url' and (i, j) not in retained:
                blocks.append({'type': 'text', 'text': '此图片本次未重复附带像素；同图已在后文附带，或是较早查看的图片。需要重新检查时，用相邻 ref_id 调用 inspect_images，不能假装仍在看该图。'})
            else:
                blocks.append(block)
        output.append({**message, 'content': blocks})
    return output
