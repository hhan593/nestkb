import { Global, Module } from '@nestjs/common';
import { ENV, loadDotenvFile, parseEnv } from './env';

/**
 * 全局环境模块：启动时一次性 zod 校验，解析为强类型 AppEnv。
 * 注入方式：`@Inject(ENV) private readonly env: AppEnv`。
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: () => {
        loadDotenvFile();
        return parseEnv(process.env);
      },
    },
  ],
  exports: [ENV],
})
export class EnvModule {}
