import { activeDrivers, env } from '../config/env';
import { readPackageVersion } from '../utils/packageInfo';

export interface VersionReport {
  name: string;
  version: string;
  env: string;
  drivers: {
    db: string;
    cache: string;
    storage: string;
    mail: string;
    payment: string;
    otp: string;
  };
}

export const versionService = {
  getVersion(): VersionReport {
    return {
      name: env.APP_NAME,
      version: readPackageVersion(),
      env: env.NODE_ENV,
      drivers: { ...activeDrivers },
    };
  },
};
