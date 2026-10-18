# Overclock on X Layer mainnet

Every transaction of the live demo, chain 196. Recorded by `scripts/demo.js --live`; the raw run is
[`web/live-run.json`](../web/live-run.json).

| | |
|---|---|
| Overclock | [`0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710`](https://www.oklink.com/x-layer/address/0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710) |
| TapeOut processor (existing "OKspace" processor) | [`0xb00f10bb4b2f32c561bf90e205e543d0a2395971`](https://www.oklink.com/x-layer/address/0xb00f10bb4b2f32c561bf90e205e543d0a2395971) |
| Circuits | cell rule #4 (57 gates), 8×8 board #5 (64 REFs to the cell, 3,712 gates per generation) |
| Job | 40 generations of Game of Life, fee 0.0002 OKB, job 0 |

The cheat corrupted one NAND (generation 25, cell (3, 2), trace leaf 110,548 of 181,840).
The watcher bisected the 18-level trace to that leaf and proved it wrong in one transaction; the
cheat's bond went to the watcher. An honest operator then claimed, nobody challenged for 10 minutes,
and the result finalized. `Overclock.result(0)` matches an independent Life simulation.

| Step | Gas | Transaction |
|---|---:|---|
| deploy Overclock (bond 0.001 OKB, 10-minute window, 2% fee) | 3,654,075 | [`0x9233c851…`](https://www.oklink.com/x-layer/tx/0x9233c8513265da20893b49a276dc744fde098ea8525175c3f5c6b2442037ea3a) |
| mint 57 NAND | 103,499 | [`0x7accc502…`](https://www.oklink.com/x-layer/tx/0x7accc50236d823d5de23a7b77584b38bb483cf6cb68738ae8b75a64fc187667b) |
| mint 64 LATCH | 86,434 | [`0x4b3ed01f…`](https://www.oklink.com/x-layer/tx/0x4b3ed01f51390010069c7af3ef10d2f32acf2b251a4484a58d108b2f94ecc458) |
| tapeout cell rule as circuit #4 | 380,366 | [`0x12700d22…`](https://www.oklink.com/x-layer/tx/0x12700d22c297dfce4f8c5d2492cefc6c059d423208c7ecb4e9229f194a197420) |
| tapeout 8x8 board as circuit #5 (64 REFs) | 2,103,982 | [`0x62450283…`](https://www.oklink.com/x-layer/tx/0x624502833d0689be847081b168058c4d96a673e3fb39f75af03b13ecca17f038) |
| poster: posts the job: 40 generations, fee 0.0002 | 430,756 | [`0x8c75adfb…`](https://www.oklink.com/x-layer/tx/0x8c75adfb5da685237bc456ccdeba59ae207c365434b73ba1130aaa4a0971bf2c) |
| cheat: claims a wrong result | 142,580 | [`0xb959394b…`](https://www.oklink.com/x-layer/tx/0xb959394b47e6523f6877da8b00395410cf6c19ab5ef74ac75967b6b867659677) |
| watcher: challenges | 133,899 | [`0x942b7927…`](https://www.oklink.com/x-layer/tx/0x942b7927db797ff55d6d67dbc2a57b2a3fbe99616123c0bb704df9abac8550b5) |
| cheat: reveals level 18 | 90,333 | [`0x16eb4373…`](https://www.oklink.com/x-layer/tx/0x16eb43736acb93e28bc4f14ae06b1b4f06c681a7669db9f35bb3c3ef06d6652d) |
| watcher: picks left at level 18 | 46,845 | [`0x726f0430…`](https://www.oklink.com/x-layer/tx/0x726f0430079011df5c1d3c0c68963fa4ebcb095165be4973d28fa267a6afd780) |
| cheat: reveals level 17 | 56,121 | [`0xb2c6bff3…`](https://www.oklink.com/x-layer/tx/0xb2c6bff3552487bd986f5ee60628c01ff1f95da593dd7dd97e957f6b76fcbbfd) |
| watcher: picks right at level 17 | 66,733 | [`0x17514d98…`](https://www.oklink.com/x-layer/tx/0x17514d987ce6953742ac2799c4cfca78283d42647b4ac45c75663c932b06ebc2) |
| cheat: reveals level 16 | 56,133 | [`0xee44541f…`](https://www.oklink.com/x-layer/tx/0xee44541fd471f800ed9947936b515d40c992ecfe7424a5cc5e338e32a761ccaf) |
| watcher: picks right at level 16 | 49,633 | [`0xce4bd061…`](https://www.oklink.com/x-layer/tx/0xce4bd061c61d59443e5288f3a43f4c8b900ccfe6259e040b2b320960c17b9d85) |
| cheat: reveals level 15 | 56,133 | [`0xdf94c43c…`](https://www.oklink.com/x-layer/tx/0xdf94c43c67b3e8cc7736422e45c5d324e47ae7862de1525ac797235989d99321) |
| watcher: picks left at level 15 | 49,645 | [`0x7c9172bd…`](https://www.oklink.com/x-layer/tx/0x7c9172bd49079c40e769aa70e15a03f9f1e02fb10bab3825378e1bbcb03ac056) |
| cheat: reveals level 14 | 56,133 | [`0xf503f7e0…`](https://www.oklink.com/x-layer/tx/0xf503f7e0028bbd4c1f7acb9920bd29f0985909fbee4249c2b4af90a3d6cdc737) |
| watcher: picks right at level 14 | 49,633 | [`0x3c002fa6…`](https://www.oklink.com/x-layer/tx/0x3c002fa66099e71162f81a6431622832bb01dbd60a5496a58e0ba71e1539d4b7) |
| cheat: reveals level 13 | 56,133 | [`0xbcc57a72…`](https://www.oklink.com/x-layer/tx/0xbcc57a7295e64fd1e2d0ea54afed4e123b9eec88cc2b830875c9d40774f9269f) |
| watcher: picks left at level 13 | 49,645 | [`0x69667b95…`](https://www.oklink.com/x-layer/tx/0x69667b957ad269d7fd80f377b25a2afc56996acef9bf1321063a52d20c392c58) |
| cheat: reveals level 12 | 56,133 | [`0xd4ae4c78…`](https://www.oklink.com/x-layer/tx/0xd4ae4c785ee2246d060d446853f0f9de28fdcc10fd70bb2d1f5fbede4f7c2a55) |
| watcher: picks right at level 12 | 49,633 | [`0x6d5256b1…`](https://www.oklink.com/x-layer/tx/0x6d5256b120d137171615e5a42b0eb629605db7849d9f81948ad67629ff97a2b9) |
| cheat: reveals level 11 | 56,133 | [`0x51069551…`](https://www.oklink.com/x-layer/tx/0x51069551aeaeb0d9675360af0eb84336debe96e2dc393927dad5c2ac7dc45c3c) |
| watcher: picks right at level 11 | 49,633 | [`0xdd1d627a…`](https://www.oklink.com/x-layer/tx/0xdd1d627a6030199a967abda903c5f655f6465fc30c2d4387c382bdaf778063dc) |
| cheat: reveals level 10 | 56,133 | [`0xfea1d6ca…`](https://www.oklink.com/x-layer/tx/0xfea1d6ca56b53f85cbe0c46e66d73f7512686b81380549243c2007d12dffd959) |
| watcher: picks right at level 10 | 49,633 | [`0x295c93fa…`](https://www.oklink.com/x-layer/tx/0x295c93fa3c86e4291d56ae2f2e74171290cd7e710e76eb97b57c597a9112ff34) |
| cheat: reveals level 9 | 56,133 | [`0x5fcc3605…`](https://www.oklink.com/x-layer/tx/0x5fcc360576f7bc162b659bf4a963b89f43ca48f64428246f2cccc0017c03bd45) |
| watcher: picks right at level 9 | 49,633 | [`0xffc81e7a…`](https://www.oklink.com/x-layer/tx/0xffc81e7a23c982f9ddbbb379d6e3e5719bdeaf35c794f201055dbfb729ac69f1) |
| cheat: reveals level 8 | 56,133 | [`0x82baece3…`](https://www.oklink.com/x-layer/tx/0x82baece3d7168372ce19e7ddbf2e2589adb6120bbfc87ffebb27bdb41389275c) |
| watcher: picks right at level 8 | 49,633 | [`0x8d9432c7…`](https://www.oklink.com/x-layer/tx/0x8d9432c7c0d7235575a9fb5ba62fa007c0198e057c09839dddf93a14c0664420) |
| cheat: reveals level 7 | 56,109 | [`0x95efed0a…`](https://www.oklink.com/x-layer/tx/0x95efed0ac263f6e70075c9974ea809a5377c47251165a6a6d97f769078f5cd84) |
| watcher: picks right at level 7 | 49,633 | [`0x6a8068fc…`](https://www.oklink.com/x-layer/tx/0x6a8068fcbc78b931c9879a6b2d3c76f88a90e77d359caf0782388f1d942061cf) |
| cheat: reveals level 6 | 56,133 | [`0xd92d1e03…`](https://www.oklink.com/x-layer/tx/0xd92d1e0353a118966c49d9f05a90414700169b98f4efa4f4905f0fa50e028de2) |
| watcher: picks left at level 6 | 49,645 | [`0x822edecd…`](https://www.oklink.com/x-layer/tx/0x822edecdd90be8c0996f5bd41b03a3947217066095f891ea3067d3e09c3485cb) |
| cheat: reveals level 5 | 56,133 | [`0x94338ec0…`](https://www.oklink.com/x-layer/tx/0x94338ec00f6d0417e734f6d539c3f9da5aaaae4cc9535658cf6cec824dea2d08) |
| watcher: picks right at level 5 | 49,633 | [`0xd370e11f…`](https://www.oklink.com/x-layer/tx/0xd370e11f31465ebfcb193a7f8f4e62567e506d706a693b453db35aa913839a86) |
| cheat: reveals level 4 | 56,121 | [`0x710936d4…`](https://www.oklink.com/x-layer/tx/0x710936d4cb02ba0db391721ec97c0fd6339acdd52e894a3e2ab3f195a7c9a656) |
| watcher: picks left at level 4 | 49,645 | [`0x89bb1d35…`](https://www.oklink.com/x-layer/tx/0x89bb1d357059c060196ec5d29b4a5791cbfee20b4359716c9476d92294596712) |
| cheat: reveals level 3 | 56,133 | [`0xca268e1e…`](https://www.oklink.com/x-layer/tx/0xca268e1e84e40d520ffb78356dddb96bcb4d80d943ff4c8e3e7465f2fbee8c4a) |
| watcher: picks right at level 3 | 49,633 | [`0x893f6f02…`](https://www.oklink.com/x-layer/tx/0x893f6f02e9470560cb44eb374c88910e3a13ba4b47dfa559a5d1497243db1cec) |
| cheat: reveals level 2 | 56,133 | [`0x98d555e5…`](https://www.oklink.com/x-layer/tx/0x98d555e5d00c1f729813fefb92ed28f636920dff5300a48abd6e9c52a6254d1f) |
| watcher: picks left at level 2 | 49,645 | [`0x485f68ec…`](https://www.oklink.com/x-layer/tx/0x485f68ece078dee1d2ca83f8407ff6b90a848289c523b2a52cf158f23dc0e34d) |
| cheat: reveals level 1 | 56,133 | [`0xd465ef82…`](https://www.oklink.com/x-layer/tx/0xd465ef8215c54cb859d7916a6dfd2e13619506d2a74886d8c5c531c0368d4dfc) |
| watcher: picks left at level 1 | 49,633 | [`0xaf90be51…`](https://www.oklink.com/x-layer/tx/0xaf90be51654a6fc9bf3f058ede17ebafeb47b2a47222fc001078455a2b9e2a67) |
| watcher: proves the wrong step | 347,509 | [`0xa4fbe532…`](https://www.oklink.com/x-layer/tx/0xa4fbe532791e6220310618304ce7f4f908a80411a887986984e0c7819a2a0bff) |
| operator: claims the result | 125,384 | [`0x75779e7f…`](https://www.oklink.com/x-layer/tx/0x75779e7f684c3fbe11cd3b68142e726149da990d283c438fb528e784abcd66c9) |
| operator: finalizes | 56,627 | [`0x2c45bc0c…`](https://www.oklink.com/x-layer/tx/0x2c45bc0c13bf1a3c2234c98d1fa1665482c6ece5cb55e8b2bc57e50035a863c6) |
