import { Injectable, UnauthorizedException } from '@nestjs/common';

type LoginPayload = {
  username: string;
  password: string;
};

@Injectable()
export class AdminSessionService {
  createSession({ username, password }: LoginPayload) {
    const configuredUsername = process.env.ADMIN_USERNAME ?? 'admin';
    const configuredPassword = process.env.ADMIN_PASSWORD ?? 'change-me';
    const configuredToken = process.env.ADMIN_TOKEN ?? 'dev-admin-token';

    if (username !== configuredUsername || password !== configuredPassword) {
      throw new UnauthorizedException('Invalid admin credentials');
    }

    return {
      token: configuredToken,
      profile: {
        username: configuredUsername,
      },
    };
  }
}
