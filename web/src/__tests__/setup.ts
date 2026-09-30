import { configure } from '@testing-library/react'

/**
 * 机器忙的时候（比如同时在编译 Rust、跑别的测试）整个 UI 会慢好几倍：
 * 单个用例的 testTimeout 不够用，`waitFor` 自己那个 **1 秒**默认值更不够 ——
 * 于是「只是慢」会被误判成「功能坏了」。这里统一放宽，避免假失败。
 */
configure({ asyncUtilTimeout: 15_000 })
