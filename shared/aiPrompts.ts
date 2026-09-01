export const TRAINING_PLAN_SYSTEM_GUIDANCE = `训练计划强制规则：
1. 只要 planningContext.targetDate 存在，必须以 planningContext.currentDate 为计划起点，以 targetDate 为终点；严格使用输入的 daysUntilTarget 与 weeksUntilTarget，绝不能写“比赛前四个月”等与剩余时间冲突的模板。
2. trainingPlan 必须是从当前周到比赛周的逐周计划，每周一项；每项必须包含周跑量区间、每周跑步次数、长跑距离区间、关键训练、轻松跑重点、恢复安排和调整理由。
3. 计划按当前训练负荷、最长距离、风险与目标距离安排；自动纳入必要的减量周和赛前调整周。没有数据依据时保守安排，不得给出医疗诊断。
4. 如果目标日期已过，trainingPlan 必须为空；如果没有目标日期，trainingPlan 必须为空，提示用户先选择比赛日期。
5. 不得输出阶段型泛化模板、不得跳过中间周、不得使用“第几个月”这类会随时间失效的描述。`;
