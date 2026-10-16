"""官方 Qwen-Image-2.1-Turbo 固定八步采样，兼容 Swarm 的动态 scheduler 列表。

来源: Qwen/Qwen-Image-2.1-Turbo/model_index.json 中的 sample_sigmas。
末尾零是 Comfy Euler 完成去噪所需的结束节点，不额外执行一步。
"""
import torch
import comfy.samplers

NAME = "qwen_image_21_turbo_official"
SIGMAS = (1.0, 0.978453, 0.95418, 0.926626, 0.89508,
          0.845148, 0.704534, 0.414568, 0.0)


def official_sigmas(model_sampling, steps):
    if steps != 8:
        raise ValueError("Qwen-Image-2.1-Turbo 官方模式需要 8 步")
    return torch.tensor(SIGMAS, dtype=torch.float32)


comfy.samplers.SCHEDULER_HANDLERS[NAME] = comfy.samplers.SchedulerHandler(official_sigmas)
if NAME not in comfy.samplers.SCHEDULER_NAMES:
    comfy.samplers.SCHEDULER_NAMES.append(NAME)

NODE_CLASS_MAPPINGS = {}
