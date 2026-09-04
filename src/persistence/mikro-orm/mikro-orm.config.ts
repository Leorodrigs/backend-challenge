import 'dotenv/config';

import { loadApplicationConfiguration } from '../../config/application.config.js';
import { createMikroOrmOptions } from './mikro-orm.options.js';

export default createMikroOrmOptions(loadApplicationConfiguration());
