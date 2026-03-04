"""
Aegis AI Anomaly Detection
AI 驱动的异常检测系统
"""
import numpy as np
import time
import threading
import pickle
from datetime import datetime, timedelta
from collections import deque, defaultdict
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass, field
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
from sklearn.cluster import DBSCAN
import warnings
warnings.filterwarnings('ignore')


@dataclass
class AnomalyAlert:
    """异常告警"""
    timestamp: datetime
    agent_id: str
    anomaly_type: str
    severity: str  # LOW, MEDIUM, HIGH, CRITICAL
    description: str
    trace_ids: List[str]
    confidence: float
    suggested_action: str


class FeatureExtractor:
    """特征提取器 - 从追踪数据提取异常检测特征"""

    def __init__(self):
        self.scaler = StandardScaler()
        self.is_fitted = False

    def extract_features(self, trace: Dict) -> np.ndarray:
        """提取追踪特征向量"""
        features = []

        # 1. 时间特征
        hour = datetime.fromisoformat(trace['timestamp'].rstrip('Z')).hour
        features.append(hour)  # 小时 (0-23)
        features.append(1 if hour in range(9, 17) else 0)  # 工作时间

        # 2. 操作特征
        tool_name = trace.get('tool_call', {}).get('tool_name', '')
        features.append(len(tool_name))  # 操作名长度
        features.append(1 if '_' in tool_name else 0)  # 包含下划线

        # 3. 风险特征
        risk_map = {'LOW': 0, 'MEDIUM': 1, 'HIGH': 2}
        risk_level = trace.get('tool_call', {}).get('risk_level', 'LOW')
        features.append(risk_map.get(risk_level, 0))

        # 4. 性能特征
        exec_time = trace.get('execution_time', 0)
        features.append(exec_time)
        features.append(1 if exec_time > 1.0 else 0)  # 慢操作

        # 5. 状态特征
        features.append(1 if trace.get('status') == 'error' else 0)

        # 6. 参数复杂度
        params = trace.get('tool_call', {}).get('parameters', {})
        features.append(len(str(params)))  # 参数大小

        return np.array(features)

    def fit_transform(self, traces: List[Dict]) -> np.ndarray:
        """拟合并转换特征"""
        features = np.array([self.extract_features(t) for t in traces])
        self.scaler.fit(features)
        self.is_fitted = True
        return self.scaler.transform(features)

    def transform(self, traces: List[Dict]) -> np.ndarray:
        """转换特征"""
        features = np.array([self.extract_features(t) for t in traces])
        if self.is_fitted:
            return self.scaler.transform(features)
        return features


class BehaviorProfiler:
    """行为分析器 - 学习正常行为模式"""

    def __init__(self, window_size: int = 1000):
        self.window_size = window_size
        self.agent_profiles = defaultdict(lambda: {
            'operations': deque(maxlen=window_size),
            'sequences': defaultdict(int),
            'timing_patterns': deque(maxlen=window_size),
            'error_rate': deque(maxlen=100),
            'risk_distribution': defaultdict(int)
        })

    def update_profile(self, agent_id: str, trace: Dict):
        """更新 Agent 行为档案"""
        profile = self.agent_profiles[agent_id]

        # 记录操作
        operation = trace.get('tool_call', {}).get('tool_name', '')
        profile['operations'].append(operation)

        # 记录操作序列
        if len(profile['operations']) >= 2:
            sequence = tuple(list(profile['operations'])[-2:])
            profile['sequences'][sequence] += 1

        # 记录时间模式
        profile['timing_patterns'].append({
            'hour': datetime.fromisoformat(trace['timestamp'].rstrip('Z')).hour,
            'execution_time': trace.get('execution_time', 0)
        })

        # 更新错误率
        is_error = trace.get('status') == 'error'
        profile['error_rate'].append(1 if is_error else 0)

        # 更新风险分布
        risk_level = trace.get('tool_call', {}).get('risk_level', 'LOW')
        profile['risk_distribution'][risk_level] += 1

    def get_anomaly_score(self, agent_id: str, trace: Dict) -> float:
        """计算行为异常分数"""
        if agent_id not in self.agent_profiles:
            return 0.0  # 新 Agent，无历史数据

        profile = self.agent_profiles[agent_id]
        anomaly_scores = []

        # 1. 操作频率异常
        operation = trace.get('tool_call', {}).get('tool_name', '')
        op_count = sum(1 for op in profile['operations'] if op == operation)
        op_freq = op_count / len(profile['operations']) if profile['operations'] else 0
        if op_freq < 0.01:  # 罕见操作
            anomaly_scores.append(0.8)

        # 2. 时间模式异常
        hour = datetime.fromisoformat(trace['timestamp'].rstrip('Z')).hour
        hour_counts = defaultdict(int)
        for pattern in profile['timing_patterns']:
            hour_counts[pattern['hour']] += 1

        if hour_counts and hour not in hour_counts:
            anomaly_scores.append(0.6)  # 异常时间

        # 3. 错误率异常
        current_error_rate = sum(profile['error_rate']) / len(profile['error_rate']) \
                           if profile['error_rate'] else 0
        if trace.get('status') == 'error' and current_error_rate < 0.05:
            anomaly_scores.append(0.7)  # 异常错误

        # 4. 执行时间异常
        exec_time = trace.get('execution_time', 0)
        avg_exec_time = np.mean([p['execution_time'] for p in profile['timing_patterns']]) \
                       if profile['timing_patterns'] else 0

        if exec_time > avg_exec_time * 3:  # 3倍标准时间
            anomaly_scores.append(0.5)

        return max(anomaly_scores) if anomaly_scores else 0.0


class AnomalyDetector:
    """异常检测器 - 使用多种算法检测异常"""

    def __init__(self):
        self.isolation_forest = IsolationForest(
            contamination=0.1,
            random_state=42,
            n_estimators=100
        )
        self.feature_extractor = FeatureExtractor()
        self.behavior_profiler = BehaviorProfiler()
        self.is_trained = False

        # 异常模式库
        self.known_patterns = {
            'brute_force': {
                'description': '暴力破解尝试',
                'indicators': ['high_error_rate', 'rapid_attempts', 'sequential_params']
            },
            'data_exfiltration': {
                'description': '数据泄露',
                'indicators': ['large_data_reads', 'unusual_hours', 'new_destinations']
            },
            'privilege_escalation': {
                'description': '权限提升',
                'indicators': ['admin_ops_increase', 'new_high_risk_ops', 'role_changes']
            },
            'dos_attack': {
                'description': '拒绝服务攻击',
                'indicators': ['extreme_volume', 'resource_exhaustion', 'repetitive_ops']
            }
        }

        # 实时指标
        self.metrics = {
            'total_analyzed': 0,
            'anomalies_detected': 0,
            'false_positives': 0,
            'patterns_matched': defaultdict(int)
        }

    def train(self, historical_traces: List[Dict]):
        """训练异常检测模型"""
        print("🤖 Training anomaly detection model...")

        # 提取特征
        if len(historical_traces) < 100:
            print("⚠️  Insufficient data for training (need at least 100 traces)")
            return

        # 训练特征提取器
        features = self.feature_extractor.fit_transform(historical_traces)

        # 训练 Isolation Forest
        self.isolation_forest.fit(features)
        self.is_trained = True

        # 构建行为档案
        for trace in historical_traces:
            agent_id = trace.get('agent_id', 'unknown')
            self.behavior_profiler.update_profile(agent_id, trace)

        print(f"✅ Model trained on {len(historical_traces)} traces")

    def detect_anomaly(self, trace: Dict) -> Optional[AnomalyAlert]:
        """检测单个追踪是否异常"""
        self.metrics['total_analyzed'] += 1

        if not self.is_trained:
            return None

        # 1. 基于 ML 的异常检测
        features = self.feature_extractor.transform([trace])
        anomaly_score = -self.isolation_forest.score_samples(features)[0]

        # 2. 基于行为的异常检测
        agent_id = trace.get('agent_id', 'unknown')
        behavior_score = self.behavior_profiler.get_anomaly_score(agent_id, trace)

        # 3. 基于规则的模式匹配
        pattern_matches = self._match_patterns(trace)

        # 综合判断
        combined_score = max(anomaly_score, behavior_score)

        if combined_score > 0.5 or pattern_matches:
            self.metrics['anomalies_detected'] += 1

            # 确定严重程度
            if combined_score > 0.8 or len(pattern_matches) > 1:
                severity = "CRITICAL"
            elif combined_score > 0.6:
                severity = "HIGH"
            elif combined_score > 0.4:
                severity = "MEDIUM"
            else:
                severity = "LOW"

            # 生成告警
            alert = AnomalyAlert(
                timestamp=datetime.now(),
                agent_id=agent_id,
                anomaly_type=pattern_matches[0] if pattern_matches else "behavioral",
                severity=severity,
                description=self._generate_description(trace, combined_score, pattern_matches),
                trace_ids=[trace.get('trace_id', '')],
                confidence=combined_score,
                suggested_action=self._suggest_action(severity, pattern_matches)
            )

            return alert

        return None

    def _match_patterns(self, trace: Dict) -> List[str]:
        """匹配已知异常模式"""
        matched = []

        # 简化的模式匹配逻辑
        if trace.get('status') == 'error':
            error_rate = self._calculate_recent_error_rate(trace.get('agent_id'))
            if error_rate > 0.5:
                matched.append('brute_force')

        exec_time = trace.get('execution_time', 0)
        if exec_time > 5.0:  # 超长执行时间
            matched.append('dos_attack')

        return matched

    def _calculate_recent_error_rate(self, agent_id: str) -> float:
        """计算最近的错误率"""
        profile = self.behavior_profiler.agent_profiles.get(agent_id)
        if profile and profile['error_rate']:
            return sum(profile['error_rate']) / len(profile['error_rate'])
        return 0.0

    def _generate_description(self, trace: Dict, score: float, patterns: List[str]) -> str:
        """生成异常描述"""
        desc_parts = []

        if patterns:
            desc_parts.append(f"检测到 {', '.join(patterns)} 模式")

        desc_parts.append(f"异常分数: {score:.2f}")

        if trace.get('status') == 'error':
            desc_parts.append(f"操作失败: {trace.get('error', 'unknown')}")

        return " | ".join(desc_parts)

    def _suggest_action(self, severity: str, patterns: List[str]) -> str:
        """建议应对措施"""
        if severity == "CRITICAL":
            return "立即阻止该 Agent 并进行人工审查"
        elif severity == "HIGH":
            return "限制该 Agent 的高风险操作权限"
        elif severity == "MEDIUM":
            return "增加监控频率并设置告警"
        else:
            return "记录并继续观察"

    def get_statistics(self) -> Dict[str, Any]:
        """获取检测统计"""
        return {
            **self.metrics,
            'detection_rate': f"{self.metrics['anomalies_detected']/self.metrics['total_analyzed']*100:.1f}%"
                            if self.metrics['total_analyzed'] > 0 else "0%",
            'model_trained': self.is_trained
        }


class AnomalyDetectionSystem:
    """完整的异常检测系统"""

    def __init__(self, alert_callback=None):
        self.detector = AnomalyDetector()
        self.alert_callback = alert_callback
        self.alert_history = deque(maxlen=1000)
        self.trace_buffer = deque(maxlen=10000)

        # 启动后台训练线程
        self._start_training_thread()

    def _start_training_thread(self):
        """定期重新训练模型"""
        def train_loop():
            while True:
                time.sleep(300)  # 每5分钟
                if len(self.trace_buffer) >= 1000:
                    self.detector.train(list(self.trace_buffer))
                    print(f"🔄 Model retrained with {len(self.trace_buffer)} traces")

        thread = threading.Thread(target=train_loop, daemon=True)
        thread.start()

    def analyze_trace(self, trace: Dict):
        """分析追踪数据"""
        # 添加到缓冲区
        self.trace_buffer.append(trace)

        # 更新行为档案
        agent_id = trace.get('agent_id', 'unknown')
        self.detector.behavior_profiler.update_profile(agent_id, trace)

        # 检测异常
        alert = self.detector.detect_anomaly(trace)

        if alert:
            self.alert_history.append(alert)
            if self.alert_callback:
                self.alert_callback(alert)
            else:
                self._default_alert_handler(alert)

    def _default_alert_handler(self, alert: AnomalyAlert):
        """默认告警处理"""
        emoji = {
            "CRITICAL": "🚨",
            "HIGH": "⚠️",
            "MEDIUM": "⚡",
            "LOW": "💡"
        }.get(alert.severity, "📌")

        print(f"\n{emoji} ANOMALY DETECTED {emoji}")
        print(f"Time: {alert.timestamp}")
        print(f"Agent: {alert.agent_id}")
        print(f"Type: {alert.anomaly_type}")
        print(f"Severity: {alert.severity}")
        print(f"Description: {alert.description}")
        print(f"Confidence: {alert.confidence:.2%}")
        print(f"Action: {alert.suggested_action}")
        print("=" * 50)

    def get_agent_risk_scores(self) -> Dict[str, float]:
        """获取所有 Agent 的风险分数"""
        risk_scores = {}

        for agent_id in self.detector.behavior_profiler.agent_profiles:
            recent_alerts = [a for a in self.alert_history
                           if a.agent_id == agent_id
                           and a.timestamp > datetime.now() - timedelta(hours=1)]

            if recent_alerts:
                # 基于最近告警计算风险分数
                severity_weights = {"CRITICAL": 1.0, "HIGH": 0.7, "MEDIUM": 0.4, "LOW": 0.2}
                risk_score = sum(severity_weights.get(a.severity, 0) for a in recent_alerts) / 10
                risk_scores[agent_id] = min(risk_score, 1.0)
            else:
                risk_scores[agent_id] = 0.0

        return risk_scores

    def save_model(self, filepath: str):
        """保存训练好的模型"""
        model_data = {
            'detector': self.detector,
            'trace_buffer': list(self.trace_buffer),
            'alert_history': list(self.alert_history)
        }
        with open(filepath, 'wb') as f:
            pickle.dump(model_data, f)
        print(f"💾 Model saved to {filepath}")

    def load_model(self, filepath: str):
        """加载模型"""
        with open(filepath, 'rb') as f:
            model_data = pickle.load(f)
        self.detector = model_data['detector']
        self.trace_buffer = deque(model_data['trace_buffer'], maxlen=10000)
        self.alert_history = deque(model_data['alert_history'], maxlen=1000)
        print(f"📂 Model loaded from {filepath}")


# 集成到 Aegis 客户端
class AegisMonitorWithAnomalyDetection:
    """带异常检测的 Aegis 监控客户端"""

    def __init__(self):
        self.anomaly_system = AnomalyDetectionSystem()
        self.agent_id = "ai-agent-001"

    def trace(self, operation: str, risk_level: str = "LOW"):
        """带异常检测的追踪装饰器"""
        def decorator(func):
            @functools.wraps(func)
            def wrapper(*args, **kwargs):
                start_time = time.time()
                trace_id = f"{self.agent_id}_{int(time.time()*1000)}"

                trace_data = {
                    'trace_id': trace_id,
                    'agent_id': self.agent_id,
                    'timestamp': datetime.utcnow().isoformat() + 'Z',
                    'tool_call': {
                        'tool_name': operation,
                        'risk_level': risk_level,
                        'parameters': {'args': str(args)[:100]}
                    }
                }

                try:
                    result = func(*args, **kwargs)
                    trace_data['status'] = 'success'
                    trace_data['execution_time'] = time.time() - start_time
                    return result

                except Exception as e:
                    trace_data['status'] = 'error'
                    trace_data['error'] = str(e)
                    trace_data['execution_time'] = time.time() - start_time
                    raise

                finally:
                    # 异常检测分析
                    self.anomaly_system.analyze_trace(trace_data)

            return wrapper
        return decorator


# 演示代码
if __name__ == "__main__":
    import random
    import functools

    print("🤖 Aegis AI Anomaly Detection Demo")
    print("=" * 60)

    # 创建带异常检测的监控器
    monitor = AegisMonitorWithAnomalyDetection()

    # 定义一些测试操作
    @monitor.trace("read_data", risk_level="LOW")
    def normal_operation():
        time.sleep(random.uniform(0.01, 0.05))
        return "success"

    @monitor.trace("process_payment", risk_level="HIGH")
    def risky_operation():
        time.sleep(random.uniform(0.05, 0.1))
        if random.random() < 0.05:  # 5% 失败率
            raise Exception("Payment failed")
        return "payment processed"

    @monitor.trace("admin_delete", risk_level="HIGH")
    def suspicious_operation():
        time.sleep(random.uniform(0.1, 5.0))  # 异常长的执行时间
        return "deleted"

    # 生成训练数据
    print("📊 Generating training data...")
    for i in range(200):
        try:
            if random.random() < 0.8:
                normal_operation()
            else:
                risky_operation()
        except:
            pass

        if i == 100:
            # 训练模型
            monitor.anomaly_system.detector.train(
                list(monitor.anomaly_system.trace_buffer)
            )

    print("\n🚨 Starting anomaly detection...\n")

    # 模拟异常行为
    for i in range(50):
        try:
            # 正常行为
            if i < 20:
                normal_operation()

            # 突然的高错误率（暴力破解）
            elif i < 30:
                try:
                    risky_operation()
                    if random.random() < 0.8:  # 80% 错误
                        raise Exception("Simulated attack")
                except:
                    pass

            # 异常长时间操作（DoS）
            elif i < 40:
                suspicious_operation()

            # 恢复正常
            else:
                normal_operation()

        except:
            pass

        time.sleep(0.1)

    # 显示统计
    print("\n" + "=" * 60)
    print("📊 Anomaly Detection Statistics:")
    stats = monitor.anomaly_system.detector.get_statistics()
    for key, value in stats.items():
        print(f"  {key}: {value}")

    # 显示风险评分
    print("\n🎯 Agent Risk Scores:")
    risk_scores = monitor.anomaly_system.get_agent_risk_scores()
    for agent_id, score in risk_scores.items():
        risk_level = "🟢 Low" if score < 0.3 else "🟡 Medium" if score < 0.7 else "🔴 High"
        print(f"  {agent_id}: {score:.2f} ({risk_level})")